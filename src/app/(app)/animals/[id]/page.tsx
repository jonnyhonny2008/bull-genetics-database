import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, SEXES, ID_TYPES, label, COUNTRIES } from "@/lib/constants";
import { SireClassBadges } from "@/components/SireFilters";
import { activityLabel, officialLabel, isGenotyped } from "@/lib/sire-class";
import { PageHeader, Card, Badge, Table, EmptyState, statusTone } from "@/components/ui";
import { fmtDate, fmtNum } from "@/lib/format";
import { loadRankMap, pickPreferred } from "@/lib/priority";
import { qualityFlagsFor } from "@/lib/quality";
import { matchExistingAnimals } from "@/lib/quality";
import { archiveAnimal, addNote } from "../actions";
import { LinearGraph, type LinearGroup, type LinearTraitDatum } from "@/components/LinearGraph";
import { caFavourableEnd } from "@/lib/ca-linear";
import { TraitTrendChart, type TrendSeries } from "@/components/TraitTrendChart";
import { computeRollback, ratingVerdict, ROLLBACK_TRAIT_LABELS, proofKind } from "@/lib/rollback";
import { getRollbackTraitScales } from "@/lib/reference";
import FavouriteStar from "@/components/FavouriteStar";
import { attachTraits, traitDefMap } from "@/lib/eval-traits";
import { PedigreeTree } from "@/components/PedigreeTree";
import {
  HolsteinFamilyTreeCard, HolsteinProgenyCard, HolsteinLactationsCard,
} from "@/components/HolsteinProfile";
import { parseHolsteinProfileJson } from "@/lib/holstein-parse";
import RefreshHolstein from "./RefreshHolstein";
import { parsePedigreeNotes, resolveAncestors, computePedigreeIndex, OBTAINABLE_WEIGHT } from "@/lib/pedigree";
import CrossSystemBanner from "@/components/CrossSystemBanner";

export const dynamic = "force-dynamic";

// The headline index traits shown on the Genetics summary (indexed eval columns).
const KEY_TRAITS: { col: string; label: string }[] = [
  { col: "lpi", label: "LPI" }, { col: "proDollar", label: "Pro$" }, { col: "conf", label: "Conformation" },
  { col: "milk", label: "Milk" }, { col: "fat", label: "Fat" }, { col: "prot", label: "Protein" },
  { col: "mamm", label: "Mammary" }, { col: "fl", label: "Feet & Legs" }, { col: "ds", label: "Dairy Strength" },
];

export default async function AnimalProfile({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | undefined>;
}) {
  const user = currentUser();
  const writable = can(user?.role, "animal:write");

  const a = await prisma.animal.findFirst({
    where: { id: params.id, archived: false },
    include: {
      breed: true,
      identifiers: { orderBy: [{ isPrimary: "desc" }, { idType: "asc" }], include: { source: true } },
      evaluations: { orderBy: { evaluationDate: "desc" }, include: { source: true } },
      milkRecords: { orderBy: { recordDate: "desc" }, include: { source: true } },
      classifications: { orderBy: { classificationDate: "desc" }, include: { traitValues: { orderBy: { displayOrder: "asc" } }, source: true } },
      animalNotes: { orderBy: { createdAt: "desc" }, include: {} },
      pedigreeRefs: { include: { source: true } },
      captures: { orderBy: { capturedAt: "desc" }, include: { source: true } },
    },
  });
  if (!a) notFound();

  const isFemale = a.sex === "F";
  // An imported evaluation still marked pending means this animal is part of an
  // import awaiting an admin's approval in the review queue.
  const hasPending = a.evaluations.some((e) => e.approvalStatus === "pending");
  // Per-trait trend across this bull's APPROVED proof rounds (oldest → newest),
  // built from the indexed evaluation columns. Traits with <2 points are dropped.
  const trendEvals = [...a.evaluations]
    .filter((e) => e.approvalStatus === "approved")
    .sort((x, y) => x.evaluationDate.getTime() - y.evaluationDate.getTime());
  const trendSeries: TrendSeries[] = KEY_TRAITS
    .map((kt) => ({
      code: kt.col,
      label: kt.label,
      points: trendEvals
        .map((e) => ({ date: e.evaluationDate.toISOString().slice(0, 10), label: e.proofRun ?? fmtDate(e.evaluationDate), value: (e as Record<string, unknown>)[kt.col] as number | null }))
        .filter((p): p is TrendSeries["points"][number] => p.value != null),
    }))
    .filter((se) => se.points.length >= 2);
  const profile = parseHolsteinProfileJson(a.holsteinProfileJson);
  // Owners/breeders and show awards are breed-association registry data. The
  // Lactanet source doesn't publish them, so those two tabs are gone rather
  // than sitting there permanently empty.
  const hasProgeny = !!profile && profile.progeny.length > 0;

  // Sex-aware, holstein.ca-style tab set. Owner History / Progeny appear only
  // when the scrape captured that data (so CDN-only bulls don't get empty tabs).
  const TABS: { code: string; label: string }[] = [
    { code: "main", label: "Main" },
    { code: "genetics", label: "Genetics" },
    { code: "conformation", label: "Conformation" },
    ...(isFemale ? [{ code: "lactations", label: "Lactations" }] : []),
    { code: "familytree", label: "Family Tree" },
    ...(hasProgeny ? [{ code: "progeny", label: "Progeny" }] : []),
  ];
  const tab = TABS.find((t) => t.code === searchParams.tab)?.code ?? "main";

  // Rebuild the familiar traitValues[] array from packed storage.
  const defMap = await traitDefMap();
  const evaluations = attachTraits(a.evaluations, defMap);

  // Live preferred resolution + reasons.
  const [geRank, clRank] = await Promise.all([
    loadRankMap("genetic_evaluation", a.breedId),
    loadRankMap("classification", a.breedId),
  ]);
  const prefProof = pickPreferred(evaluations, {
    getSourceId: (e) => e.sourceId, getDate: (e) => e.evaluationDate, getApproval: (e) => e.approvalStatus,
    // Same-round tie → official over interim, so the profile's "most recent"
    // view agrees with the isPreferred flag the rest of the app uses.
    getTieBreak: (e) => (e.runKind === "official" ? 0 : e.runKind === "interim" ? 1 : 2),
    rankMap: geRank, domainLabel: "genetic evaluations",
  });
  const prefClass = pickPreferred(a.classifications, {
    getSourceId: (c) => c.sourceId, getDate: (c) => c.classificationDate, getApproval: (c) => c.approvalStatus,
    rankMap: clRank, domainLabel: "classification",
  });

  const quality = qualityFlagsFor(a as any);
  // Duplicate detection is rendered only by the Main tab's "Data quality" card,
  // and it costs an unindexed primaryName LIKE scan — don't pay for it elsewhere.
  const dupes = tab === "main"
    ? (await matchExistingAnimals({
        name: a.primaryName,
        identifiers: a.identifiers.map((i) => ({ idType: i.idType, idValue: i.idValue })),
        breedId: a.breedId, sex: a.sex,
      })).filter((d) => d.id !== a.id)
    : [];

  const primary = a.identifiers.find((i) => i.isPrimary);
  const naab = a.identifiers.find((i) => i.idType === "naab")?.idValue ?? null;
  const caReg = a.identifiers.find((i) => i.idType === "registration_ca")?.idValue ?? null;
  const preferredEvalId = prefProof.chosen?.evaluationId;
  const preferredClassId = prefClass.chosen?.classificationId;
  const pref = prefProof.chosen;

  // --- Which proof to SHOW (indices, trait detail, linear) -------------------
  // The preferred proof is the most recent (official winning a same-round tie).
  // A proven bull's newest round is often an interim monthly update, so the
  // profile also offers "latest official" — the most recent round that shipped an
  // official file — for anyone who wants the settled published proof instead.
  const officialEval = evaluations
    .filter((e) => e.approvalStatus === "approved" && e.runKind === "official")
    .sort((x, y) => y.evaluationDate.getTime() - x.evaluationDate.getTime())[0] ?? null;
  // Only offer the choice when it would actually change what's shown.
  const canPickOfficial = !!officialEval && officialEval.evaluationId !== pref?.evaluationId;
  const proofView = searchParams.proof === "official" && canPickOfficial ? "official" : "recent";
  const displayEval = proofView === "official" ? officialEval : pref;

  const latestClass = prefClass.chosen ?? a.classifications[0] ?? null;

  // Group the displayed proof's trait values by category (exclude linear traits — they get their own graph).
  const linearDefs = await prisma.traitDefinition.findMany({ where: { domain: "genetic", isLinear: true } });
  const linDef = new Map(linearDefs.map((d) => [d.traitCode, d]));
  const prefTraits = displayEval?.traitValues ?? [];
  const byCat = new Map<string, typeof prefTraits>();
  for (const t of prefTraits) {
    if (linDef.has(t.traitCode)) continue;
    const c = t.traitCategory ?? "Other";
    const arr = byCat.get(c) ?? [];
    arr.push(t);
    byCat.set(c, arr);
  }

  // Linear conformation graph from the preferred proof's linear values.
  const linByGroup = new Map<string, { order: number; datum: LinearTraitDatum }[]>();
  for (const tv of prefTraits) {
    const d = linDef.get(tv.traitCode);
    if (!d || tv.numericValue == null) continue;
    const g = d.graphGroup ?? "Type";
    const arr = linByGroup.get(g) ?? [];
    arr.push({ order: d.displayOrder, datum: { name: d.traitName, value: tv.numericValue, min: d.graphMin ?? -15, max: d.graphMax ?? 15, left: d.leftLabel ?? "", right: d.rightLabel ?? "", descriptor: tv.textValue, favourable: caFavourableEnd(d.traitCode, d.traitName, d.higherIsBetter) } });
    linByGroup.set(g, arr);
  }
  const GROUP_ORDER = ["Dairy Strength", "Rump", "Feet & Legs", "Mammary System"];
  const linearGroups: LinearGroup[] = [...linByGroup.entries()]
    .map(([group, arr]) => ({ group, traits: arr.sort((x, y) => x.order - y.order).map((x) => x.datum) }))
    .sort((x, y) => (GROUP_ORDER.indexOf(x.group) + 99) - (GROUP_ORDER.indexOf(y.group) + 99));

  // Proof Performance (live) + Rollback Resistance (materialised). The lineup step
  // SDs put zero-centred traits on the same scale as the stored columns.
  const rbScales = await getRollbackTraitScales();
  const rollback = computeRollback(
    evaluations.map((e) => ({ evaluationDate: e.evaluationDate, proofRun: e.proofRun, reliabilityOverall: e.reliabilityOverall, runKind: e.runKind, traitValues: e.traitValues })),
    { traitScales: rbScales },
  );
  const rbVerdict = a.rollbackResistance != null ? ratingVerdict(a.rollbackResistance) : null;

  // Pedigree — resolved live only on the Family Tree tab.
  const pedNotes = a.pedigreeRefs.map((p) => p.notes).find((n) => n && /\bSIRE:/i.test(n)) ?? null;
  const parsedAncestors = parsePedigreeNotes(pedNotes);
  const pedAncestors = tab === "familytree" ? await resolveAncestors(prisma, parsedAncestors) : [];
  const pedIndex = tab === "familytree" ? computePedigreeIndex(pedAncestors) : null;

  const tabHref = (t: string) => (t === "main" ? `/animals/${a.id}` : `/animals/${a.id}?tab=${t}`);
  // Link that flips the proof view while staying on the current tab.
  const proofViewHref = (v: "recent" | "official") => {
    const parts = [tab !== "main" ? `tab=${tab}` : "", v === "official" ? "proof=official" : ""].filter(Boolean);
    return `/animals/${a.id}${parts.length ? `?${parts.join("&")}` : ""}`;
  };
  const keyVal = (col: string) => (displayEval ? (displayEval as Record<string, unknown>)[col] as number | null : null);

  // Toggle shown on the Genetics + Conformation tabs when a bull's newest proof
  // is not itself an official one, so the indices / linear / genomics below can be
  // read from either the most recent proof or the latest official proof.
  const recentKindLabel = pref?.runKind === "official" ? "official" : pref?.runKind === "interim" ? "interim" : "latest";
  const proofSelector = canPickOfficial ? (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <span className="font-medium text-slate-500">Showing</span>
      <Link href={proofViewHref("recent")}
        className={`rounded-full px-3 py-1 font-medium ${proofView === "recent" ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>
        Most recent — {pref?.proofRun ?? "—"} ({recentKindLabel})
      </Link>
      <Link href={proofViewHref("official")}
        className={`rounded-full px-3 py-1 font-medium ${proofView === "official" ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>
        Latest official — {officialEval?.proofRun ?? "—"}
      </Link>
    </div>
  ) : null;
  const latestLactation = profile?.lactations?.length ? profile.lactations[profile.lactations.length - 1] : null;

  // Whether the signed-in user has favourited this bull.
  const isFav = user
    ? !!(await prisma.watchlist.findUnique({ where: { userId_animalId: { userId: user.uid, animalId: a.id } }, select: { id: true } }))
    : false;

  return (
    <div>
      <PageHeader
        title={a.primaryName}
        subtitle={
          <span className="block">
            {`${a.breed?.breedName ?? "No breed"} · ${SEXES[a.sex as keyof typeof SEXES] ?? a.sex}${a.shortName ? ` · "${a.shortName}"` : ""}`}
            {(primary || naab) && (
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                {primary && <span className="font-mono text-slate-500" title="Primary registration number">{primary.idValue}</span>}
                {naab && <span className="rounded bg-brand-50 px-1.5 py-0.5 font-mono font-medium text-brand-700" title="NAAB stud code (secondary identifier)">NAAB {naab}</span>}
              </span>
            )}
            {hasPending && (
              <span className="mt-1 flex">
                <Link href="/review" className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200" title="This animal was imported and is awaiting an admin's approval in the review queue">
                  ⏳ Pending admin approval — open review queue
                </Link>
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FavouriteStar animalId={a.id} initial={isFav} size="lg" />
            {writable && caReg && <RefreshHolstein reg={caReg} />}
            <Link href={`/compare?bulls=${a.id}`} className="btn-secondary">Compare</Link>
            {writable && <Link href={`/animals/${a.id}/edit`} className="btn-secondary">Edit</Link>}
            {writable && (
              <form action={archiveAnimal}>
                <input type="hidden" name="id" value={a.id} />
                <button className="btn-danger" type="submit">Archive</button>
              </form>
            )}
          </div>
        }
      />

      {/* Whether this same bull also has a CDCB evaluation, and a link to it.
          Existence, round count and round label only — no American value is read
          or shown here (kg vs lb). Renders nothing if the US tables don't exist. */}
      <CrossSystemBanner animalId={a.id} system="ca" />

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {TABS.map((t) => (
          <Link
            key={t.code}
            href={tabHref(t.code)}
            className={`rounded-full px-4 py-1.5 font-medium ${tab === t.code ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* ================= MAIN (summary) ================= */}
      {tab === "main" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Overview" className="lg:col-span-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
                <Fact k="Breed" v={a.breed?.breedName ?? "—"} />
                <Fact k="Sex" v={SEXES[a.sex as keyof typeof SEXES] ?? a.sex} />
                <Fact k="Birth date" v={fmtDate(a.birthDate)} />
                <Fact k="Country" v={label(COUNTRIES, a.countryOfOrigin)} />
                <Fact k="Status" v={<Badge>{a.currentStatus}</Badge>} />
                <Fact k="Primary identifier" v={primary ? <span className="font-mono text-xs">{primary.idValue}</span> : "—"} />
                {!isFemale && (
                  <Fact k="Sire role" v={
                    a.sireType || a.proofStatus
                      ? <SireClassBadges sireType={a.sireType} proofStatus={a.proofStatus} rollbackCount={a.rollbackCount} proofRoundCount={a.proofRoundCount} activityCode={a.latestActivityCode} />
                      : <span className="text-slate-400" title="Set on proof import — this animal has no approved genetic proof yet.">not classified</span>
                  } />
                )}
                {!isFemale && <Fact k="Proof rounds" v={a.proofRoundCount ? `${a.proofRoundCount}${a.latestProofRun ? ` · latest ${a.latestProofRun}` : ""}` : "—"} />}
                {isFemale && <Fact k="Classification" v={latestClass ? `${latestClass.classificationCode ?? ""} ${latestClass.finalScore ?? ""}`.trim() || "—" : "—"} />}
                {isFemale && <Fact k="Lactations" v={a.milkRecords.length || profile?.lactations?.length || "—"} />}
                <Fact k="Internal system ID" v={<span className="font-mono text-[10px] text-slate-400">{a.id}</span>} />
              </dl>
              {a.notes && <p className="mt-3 rounded-md bg-slate-50 p-2 text-sm text-slate-600">{a.notes}</p>}
            </Card>

            <Card title="Data quality">
              {quality.length === 0 && dupes.length === 0 ? (
                <div className="text-sm text-emerald-700">✓ No data-quality issues detected.</div>
              ) : (
                <ul className="space-y-1 text-sm">
                  {quality.map((q) => (
                    <li key={q.code} className="flex items-center gap-2">
                      <Badge tone={q.severity === "error" ? "red" : q.severity === "warn" ? "amber" : "slate"}>{q.severity}</Badge>
                      {q.label}
                    </li>
                  ))}
                  {dupes.length > 0 && (
                    <li className="flex items-center gap-2">
                      <Badge tone="purple">duplicate?</Badge>
                      Possible match: {dupes.slice(0, 2).map((d) => <Link key={d.id} href={`/animals/${d.id}`} className="link ml-1">{d.primaryName}</Link>)}
                    </li>
                  )}
                </ul>
              )}
            </Card>
          </div>

          {/* Summary digest — mirrors holstein.ca's main page highlights */}
          <Card title="Summary" actions={<Link href={tabHref("genetics")} className="link text-xs">Full genetics →</Link>}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Genetic indices {pref?.proofRun ? <span className="text-slate-400">· {pref.proofRun}</span> : null}</div>
                {pref ? (
                  <div className="space-y-1 text-sm">
                    {[["LPI", "lpi"], ["Pro$", "proDollar"], ["Conformation", "conf"]].map(([lab, col]) => (
                      <div key={col} className="flex items-center justify-between gap-2 rounded-md border border-slate-100 px-2 py-1">
                        <span className="text-slate-600">{lab}</span><span className="font-semibold tabular-nums">{keyVal(col) ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                ) : <EmptyState message="No genetic proof yet." />}
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Classification</div>
                {latestClass ? (
                  <Link href={tabHref("conformation")} className="block rounded-md border border-slate-100 px-3 py-2 hover:bg-slate-50">
                    <div className="text-lg font-bold text-slate-800">{latestClass.classificationCode ?? "—"} {latestClass.finalScore ?? ""}</div>
                    <div className="text-xs text-slate-400">{fmtDate(latestClass.classificationDate)}{latestClass.lactationNumber ? ` · Lact ${latestClass.lactationNumber}` : ""}</div>
                  </Link>
                ) : <EmptyState message={isFemale ? "Not yet classified." : "Bulls are not classified."} />}
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{isFemale ? "Latest lactation" : "Proof performance"}</div>
                {isFemale ? (
                  latestLactation ? (
                    <Link href={tabHref("lactations")} className="block rounded-md border border-slate-100 px-3 py-2 hover:bg-slate-50">
                      <div className="text-sm font-semibold text-slate-800">Lact {latestLactation.lactationNumber} · {latestLactation.milk?.toLocaleString() ?? "—"} kg</div>
                      <div className="text-xs text-slate-400">{latestLactation.dim ?? "—"} DIM · Fat {latestLactation.fat ?? "—"} · Prot {latestLactation.prot ?? "—"}</div>
                    </Link>
                  ) : <EmptyState message="No lactation records." />
                ) : (
                  rollback.hasHistory ? (
                    <Link href={tabHref("genetics")} className="block rounded-md border border-slate-100 px-3 py-2 hover:bg-slate-50">
                      <div className="text-lg font-bold text-slate-800">{rollback.proofPerformance}<span className="text-xs text-slate-400"> / 100</span></div>
                      <div className="text-xs text-slate-400">{rollback.rounds.length} rounds{a.rollbackResistance != null ? ` · Rollback ${a.rollbackResistance}` : ""}</div>
                    </Link>
                  ) : <EmptyState message="Single proof round." />
                )}
              </div>
            </div>
          </Card>

          <Card title={`Identifiers (${a.identifiers.length})`}>
            {a.identifiers.length === 0 ? <EmptyState message="No identifiers." /> : (
              <Table head={<><th className="th">Type</th><th className="th">Value</th><th className="th">Source</th><th className="th">Primary</th></>}>
                {a.identifiers.map((i) => (
                  <tr key={i.identifierId}>
                    <td className="td">{label(ID_TYPES, i.idType)}</td>
                    <td className="td font-mono text-xs">{i.idValue}</td>
                    <td className="td text-xs text-slate-500">{i.source?.sourceName ?? "—"}</td>
                    <td className="td">{i.isPrimary ? <Badge tone="green">primary</Badge> : ""}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Source history (uploads & captures)">
            {a.captures.length === 0 ? <EmptyState message="No source captures linked." /> : (
              <Table head={<><th className="th">When</th><th className="th">Type</th><th className="th">File / URL</th><th className="th">Source</th><th className="th">Extraction</th></>}>
                {a.captures.map((c) => (
                  <tr key={c.captureId}>
                    <td className="td">{fmtDate(c.capturedAt)}</td>
                    <td className="td">{c.captureType}</td>
                    <td className="td text-xs">{c.originalFileName ?? c.sourceUrl ?? "—"}</td>
                    <td className="td text-xs text-slate-500">{c.source?.sourceName ?? "—"}</td>
                    <td className="td"><Badge>{c.extractionStatus}</Badge></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Notes">
            {writable && (
              <form action={addNote} className="mb-3 flex gap-2">
                <input type="hidden" name="animalId" value={a.id} />
                <select name="noteType" className="input max-w-[160px]">
                  <option value="general">General</option>
                  <option value="data_quality">Data quality</option>
                </select>
                <input name="body" placeholder="Add an internal note…" className="input flex-1" />
                <button type="submit" className="btn-primary">Add</button>
              </form>
            )}
            {a.animalNotes.length === 0 ? <EmptyState message="No notes." /> : (
              <ul className="space-y-2">
                {a.animalNotes.map((n) => (
                  <li key={n.id} className="rounded-md border border-slate-200 p-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone={n.noteType === "data_quality" ? "amber" : "slate"}>{n.noteType}</Badge>
                      <span className="text-xs text-slate-400">{fmtDate(n.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-slate-700">{n.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {/* ================= GENETICS ================= */}
      {tab === "genetics" && (
        <div className="space-y-4">
          {proofSelector}
          <Card title="Genomic status">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Fact k="Classification" v={
                a.sireType
                  ? <span>{a.sireType === "proven" ? "Proven" : "Genomic"} — {a.sireType === "proven" ? "has daughter-based EBVs" : "GPA genomics only, not yet proven"}</span>
                  : "Not classified (no approved proof)"
              } />
              <Fact k="Genotyped" v={
                a.latestActivityCode
                  ? (isGenotyped(a.latestActivityCode)
                      ? <Badge tone="blue">Yes — breeding values include genomics</Badge>
                      : <Badge tone="slate">No genomic indicator on latest round</Badge>)
                  : "—"
              } />
              <Fact k="Proof status" v={
                a.proofStatus === "active" ? "Active — available to breed to (has a NAAB stud code)"
                  : a.proofStatus === "inactive" ? "Inactive — no NAAB stud code"
                  : "—"
              } />
              <Fact k="Lactanet activity code" v={a.latestActivityCode ? <span title={activityLabel(a.latestActivityCode) ?? undefined}><span className="font-mono">{a.latestActivityCode}</span> — {activityLabel(a.latestActivityCode) ?? "unknown"}</span> : "—"} />
              <Fact k="LPI official code" v={displayEval?.officialCode ? <span><span className="font-mono">{displayEval.officialCode}</span> — {officialLabel(displayEval.officialCode) ?? "unknown"}</span> : "—"} />
              <Fact k="Daughters (shown proof)" v={displayEval?.daughters != null ? fmtNum(displayEval.daughters) : "—"} />
            </dl>
            <p className="mt-3 text-[11px] text-slate-400">
              Proven vs genomic comes from the Lactanet proof-activity code (column 24). A genomic (GPA) evaluation is a
              genomic parent average — the values below are that estimate until the animal has milking daughters.
            </p>
          </Card>

          <Card title={displayEval ? `Key index values — ${displayEval.proofRun ?? fmtDate(displayEval.evaluationDate)}${proofView === "official" ? " · official" : ""}` : "Key index values"}>
            {!displayEval ? <EmptyState message="No approved genetic proof on file." /> : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
                {KEY_TRAITS.map((t) => (
                  <div key={t.col} className="flex items-center justify-between gap-2 rounded-md border border-slate-100 px-2 py-1">
                    <span className="text-slate-600">{t.label}</span>
                    <span className="font-semibold tabular-nums">{keyVal(t.col) ?? "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {displayEval && byCat.size > 0 && (
            <Card title={`Trait detail — ${proofView === "official" ? "latest official proof" : "preferred proof"}`} actions={<span className="text-xs text-slate-400">{displayEval.source?.sourceName ?? ""}</span>}>
              <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {proofView === "official"
                  ? <><span className="font-semibold">Latest official proof:</span> {displayEval.proofRun ?? fmtDate(displayEval.evaluationDate)} — the most recent round Lactanet shipped an official file for. The preferred (most recent) proof is {pref?.proofRun ?? "—"}.</>
                  : <><span className="font-semibold">Why preferred:</span> {prefProof.reason}</>}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {[...byCat.entries()].map(([cat, traits]) => (
                  <div key={cat} className="rounded-md border border-slate-200 p-2">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{cat}</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {traits.map((t) => (
                          <tr key={t.traitCode}>
                            <td className="py-0.5 text-slate-600">{t.traitName}</td>
                            <td className="py-0.5 text-right font-medium">{t.numericValue ?? t.textValue ?? "—"}{t.unit ? <span className="ml-0.5 text-xs text-slate-400">{t.unit}</span> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title="Proof Performance · Rollback Resistance">
            {!rollback.hasHistory ? (
              <div className="text-sm text-slate-600">
                <div className="mb-1"><Badge tone="slate">Single proof round</Badge> on file{rollback.rounds[0] ? ` (${rollback.rounds[0].label})` : ""}.</div>
                <p className="text-slate-500">Both scores calculate automatically once an <strong>earlier or later</strong> proof round is imported for this animal. Rollback Resistance additionally needs at least one <strong>April</strong> round, since that is the base change it measures.</p>
              </div>
            ) : (
              <div>
                <div className="mb-4 flex flex-wrap items-center gap-6">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-16 w-16 flex-col items-center justify-center rounded-lg text-white ${rollback.verdict.tone === "good" ? "bg-brand-600" : rollback.verdict.tone === "warn" ? "bg-amber-500" : "bg-red-600"}`}>
                      <span className="text-2xl font-bold leading-none">{rollback.proofPerformance}</span>
                      <span className="text-[9px] uppercase tracking-wide">/ 100</span>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Proof Performance</div>
                      <Badge tone={rollback.verdict.tone === "good" ? "green" : rollback.verdict.tone === "warn" ? "amber" : "red"}>{rollback.verdict.label}</Badge>
                      <div className="mt-1 text-[11px] text-slate-400">Every round · {rollback.proofSteps} step{rollback.proofSteps === 1 ? "" : "s"}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className={`flex h-16 w-16 flex-col items-center justify-center rounded-lg ${
                      a.rollbackResistance == null ? "bg-slate-200 text-slate-500"
                        : a.rollbackResistance >= 105 ? "bg-brand-600 text-white"
                        : a.rollbackResistance < 95 ? "bg-red-600 text-white" : "bg-slate-500 text-white"}`}>
                      <span className="text-2xl font-bold leading-none">{a.rollbackResistance ?? "—"}</span>
                      <span className="text-[9px] uppercase tracking-wide">base 100</span>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Rollback Resistance</div>
                      {a.rollbackResistance != null ? (
                        <Badge tone={rbVerdict!.tone === "good" ? "green" : rbVerdict!.tone === "warn" ? "amber" : rbVerdict!.tone === "danger" ? "red" : "slate"}>{rbVerdict!.label}</Badge>
                      ) : (
                        <Badge tone="slate">No April round yet</Badge>
                      )}
                      <div className="mt-1 text-[11px] text-slate-400">
                        {rollback.rollbackSteps} April step{rollback.rollbackSteps === 1 ? "" : "s"}
                        {rollback.rollbackRaw != null && <> · raw {rollback.rollbackRaw}%</>}
                        {a.rollbackCohortN != null && <> · vs {a.rollbackCohortN} sires at the same stage</>}
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-500">
                    <div><span className="font-semibold">{rollback.rounds.length}</span> proof rounds, {rollback.rounds.filter((r) => r.isRollback).length} of them April base changes</div>
                    <div className="mt-0.5">Lifetime drift (first → last round): <span className="font-semibold">{rollback.headline}</span> / 100</div>
                    <div className="mt-0.5">100 = average of sires with the same number of April rounds · 5 points = 1 standard deviation</div>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="th">Trait</th><th className="th">First</th><th className="th">Latest</th><th className="th">Change</th>
                        <th className="th" title="Mean retention across every consecutive pair of rounds">Proof Perf.</th>
                        <th className="th" title="Mean retention across April base-change rounds only">April only</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {Object.values(rollback.traits).map((t) => (
                        <tr key={t.code}>
                          <td className="td font-medium">{ROLLBACK_TRAIT_LABELS[t.code] ?? t.code}</td>
                          <td className="td">{t.first}</td>
                          <td className="td">{t.latest}</td>
                          <td className={`td font-medium ${t.delta > 0 ? "text-brand-700" : t.delta < 0 ? "text-red-600" : "text-slate-500"}`}>{t.delta > 0 ? "+" : ""}{Math.round(t.delta * 100) / 100}</td>
                          <td className="td">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-16 rounded-full bg-slate-100">
                                <div className={`h-2 rounded-full ${t.stepResistance >= 99 ? "bg-brand-500" : t.stepResistance >= 97 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${t.stepResistance}%` }} />
                              </div>
                              <span className="font-semibold tabular-nums">{Math.round(t.stepResistance * 10) / 10}</span>
                            </div>
                          </td>
                          <td className="td tabular-nums" title={t.rollbackSteps ? `${t.rollbackSteps} April step${t.rollbackSteps === 1 ? "" : "s"}` : "No April round on file for this trait"}>
                            {t.rollbackResistance == null
                              ? <span className="text-slate-300">—</span>
                              : <span className={`font-semibold ${t.rollbackResistance >= 99 ? "text-brand-700" : t.rollbackResistance >= 97 ? "text-amber-600" : "text-red-600"}`}>{Math.round(t.rollbackResistance * 10) / 10}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>

          {trendSeries.length > 0 && (
            <Card title="Trait trend across proofs">
              <TraitTrendChart series={trendSeries} />
            </Card>
          )}

          <Card title={`Genetic proof history (${evaluations.length})`} actions={writable ? <Link href={`/animals/${a.id}/proofs/new`} className="link text-xs">+ Add proof</Link> : undefined}>
            {evaluations.length === 0 ? <EmptyState message="No proofs recorded." /> : (
              <div className="space-y-3">
                {evaluations.map((e) => (
                  <details key={e.evaluationId} className="rounded-md border border-slate-200" open={e.evaluationId === preferredEvalId}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-medium">{e.proofRun ?? fmtDate(e.evaluationDate)}</span>
                      <span title={e.runKind ? "Recorded from the Lactanet file this proof came from." : "No file on record for this proof — inferred from the round month (April/August/December are official)."}>
                        {(e.runKind ?? proofKind(e.evaluationDate)) === "official" ? <Badge tone="blue">Official</Badge> : <Badge>Interim</Badge>}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span>{e.source?.sourceName ?? "—"}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500">{e.countrySystem ?? ""}</span>
                      {e.reliabilityOverall != null && <Badge>Rel {(e.reliabilityOverall * 100).toFixed(0)}%</Badge>}
                      <Badge tone={statusTone(e.approvalStatus)}>{e.approvalStatus}</Badge>
                      {e.evaluationId === preferredEvalId && <Badge tone="green">preferred</Badge>}
                    </summary>
                    <div className="border-t border-slate-100 p-3">
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                        {e.traitValues.map((t) => (
                          <span key={t.traitCode} className="text-slate-600">{t.traitName}: <span className="font-medium text-slate-800">{t.numericValue ?? t.textValue ?? "—"}</span></span>
                        ))}
                      </div>
                      {e.notes && <p className="mt-2 text-xs text-slate-500">{e.notes}</p>}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ================= CONFORMATION ================= */}
      {tab === "conformation" && (
        <div className="space-y-4">
          {proofSelector}
          {linearGroups.length > 0 ? (
            <Card title="Linear conformation profile" actions={<span className="text-xs text-slate-400">{displayEval?.proofRun ?? ""} · {displayEval?.source?.sourceName ?? ""}</span>}>
              <LinearGraph groups={linearGroups} />
            </Card>
          ) : (
            <Card title="Linear conformation profile"><EmptyState message={`No linear conformation values on the ${proofView === "official" ? "latest official" : "preferred"} proof.`} /></Card>
          )}

          <Card title={`Classification history (${a.classifications.length})`} actions={writable ? <Link href={`/animals/${a.id}/classification/new`} className="link text-xs">+ Add classification</Link> : undefined}>
            {a.classifications.length === 0 ? <EmptyState message={isFemale ? "No classification records." : "Bulls are not classified."} /> : (
              <div className="space-y-2">
                {a.classifications.map((c) => (
                  <details key={c.classificationId} className="rounded-md border border-slate-200" open={c.classificationId === preferredClassId}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-medium">{c.classificationCode ?? "—"} {c.finalScore ?? ""}</span>
                      <span className="text-slate-400">·</span>
                      <span>{fmtDate(c.classificationDate)}</span>
                      {c.lactationNumber ? <><span className="text-slate-400">·</span><span className="text-slate-500">Lact {c.lactationNumber}</span></> : null}
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500">{c.source?.sourceName ?? "—"}</span>
                      {c.classificationId === preferredClassId && <Badge tone="green">preferred</Badge>}
                    </summary>
                    <div className="border-t border-slate-100 p-3 text-sm">
                      <div className="flex flex-wrap gap-x-6 gap-y-1">
                        {c.traitValues.length === 0 ? <span className="text-slate-400">No section scores recorded.</span> : c.traitValues.map((t) => (
                          <span key={t.classificationTraitValueId} className="text-slate-600">{t.traitName}: <span className="font-medium text-slate-800">{t.traitValue}</span></span>
                        ))}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ================= LACTATIONS (females) ================= */}
      {tab === "lactations" && isFemale && (
        <div className="space-y-4">
          {profile && profile.lactations.length > 0
            ? <HolsteinLactationsCard profile={profile} />
            : <Card title="Lactation records"><EmptyState message="No lactation records captured yet. Use ↻ Holstein.ca to pull them." /></Card>}

          <Card title={`Milk record history (${a.milkRecords.length})`} actions={writable ? <Link href={`/animals/${a.id}/milk/new`} className="link text-xs">+ Add milk record</Link> : undefined}>
            {a.milkRecords.length === 0 ? <EmptyState message="No milk records." /> : (
              <Table head={<><th className="th">Date</th><th className="th">Lact</th><th className="th">DIM</th><th className="th">Milk</th><th className="th">Fat</th><th className="th">Prot</th><th className="th">Source</th><th className="th">Pref</th></>}>
                {a.milkRecords.map((m) => (
                  <tr key={m.milkRecordId}>
                    <td className="td">{fmtDate(m.recordDate)}</td>
                    <td className="td">{m.lactationNumber ?? "—"}</td>
                    <td className="td">{m.daysInMilk ?? "—"}</td>
                    <td className="td">{fmtNum(m.milkAmount)}{m.milkUnit}</td>
                    <td className="td">{fmtNum(m.fatAmount)} ({m.fatPercent ?? "—"}%)</td>
                    <td className="td">{fmtNum(m.proteinAmount)} ({m.proteinPercent ?? "—"}%)</td>
                    <td className="td text-xs text-slate-500">{m.source?.sourceName ?? "—"}</td>
                    <td className="td">{m.isPreferred ? <Badge tone="green">✓</Badge> : ""}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}

      {/* ================= FAMILY TREE ================= */}
      {tab === "familytree" && (
        <div className="space-y-4">
          {pedIndex && pedIndex.confidence > 0 && (
            <Card title="Pedigree Index">
              <div>
                <div className="mb-4 flex flex-wrap items-center gap-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-16 w-20 flex-col items-center justify-center rounded-lg bg-brand-600 text-white">
                      <span className="text-2xl font-bold leading-none">{pedIndex.lpi ?? "—"}</span>
                      <span className="text-[9px] uppercase tracking-wide">PI · LPI</span>
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">Estimated LPI from pedigree</div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-2 w-28 rounded-full bg-slate-100">
                          <div className={`h-2 rounded-full ${pedIndex.confidence >= 0.85 ? "bg-brand-500" : pedIndex.confidence >= 0.5 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${Math.round(pedIndex.confidence * 100)}%` }} />
                        </div>
                        <span className="text-xs text-slate-500">{Math.round(pedIndex.confidence * 100)}% confidence</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">
                    <div className="font-semibold text-slate-600">Built from:</div>
                    {pedIndex.contributors.map((c) => (
                      <div key={c.relation}>{c.relation.toUpperCase()} <span className="text-slate-400">×{c.weight === 0.5 ? "½" : c.weight === 0.25 ? "¼" : "⅛"}</span> — {c.name ?? "—"}</div>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50"><tr><th className="th">Trait</th><th className="th">Pedigree index</th><th className="th" title="Share of the ½+¼+⅛ obtainable ancestor weight behind this trait">Weight used</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {pedIndex.traits.filter((t) => t.value != null).map((t) => (
                        <tr key={t.code}><td className="td font-medium">{t.label}</td><td className="td font-semibold tabular-nums">{t.value}</td><td className="td text-xs text-slate-500">{Math.round((t.weight / OBTAINABLE_WEIGHT) * 100)}%</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[11px] text-slate-400">
                  Parent-average estimate: ½·Sire + ¼·MGS + ⅛·GMGS, renormalised over the male-line ancestors we hold. It is an estimate from ancestors, not this animal&apos;s own proof.
                </p>
              </div>
            </Card>
          )}

          <Card title="Family tree — our records" actions={<span className="text-xs text-slate-400">{pedAncestors.length} ancestors · from proof pedigree</span>}>
            <PedigreeTree
              self={{ name: a.primaryName, reg: primary?.idValue ?? null, lpi: pref?.lpi ?? null, sireType: a.sireType, proofStatus: a.proofStatus }}
              ancestors={pedAncestors}
            />
            {pedAncestors.some((x) => x.animalId) && (
              <p className="mt-3 text-[11px] text-slate-400">Ancestors shown in white with a link are in this database — click to open their profile. Dashed cards are recorded on the proof but not held here.</p>
            )}
          </Card>

          {profile && <HolsteinFamilyTreeCard profile={profile} />}

          <Card title="Pedigree references">
            {a.pedigreeRefs.length === 0 ? (
              <EmptyState message="No pedigree reference on file." />
            ) : (
              <ul className="space-y-2 text-sm">
                {a.pedigreeRefs.map((p) => (
                  <li key={p.pedigreeReferenceId} className="rounded-md border border-slate-200 p-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{p.source?.sourceName ?? "Source"}</span>
                      <Badge tone={p.displayStatus === "linked" ? "green" : "amber"}>{p.displayStatus}</Badge>
                    </div>
                    {p.sourceUrl && <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="link break-all text-xs">{p.sourceUrl}</a>}
                    <div className="text-xs text-slate-400">Last checked: {fmtDate(p.lastCheckedAt)}</div>
                    {p.notes && <div className="mt-1 text-xs text-slate-500">{p.notes}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {/* Owner History removed: owners/breeders are breed-association registry
          data, which the Lactanet source does not publish. */}

      {/* ================= PROGENY ================= */}
      {tab === "progeny" && profile && (
        <div className="space-y-4"><HolsteinProgenyCard profile={profile} /></div>
      )}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
      <dd className="mt-0.5 text-slate-800">{v}</dd>
    </div>
  );
}
