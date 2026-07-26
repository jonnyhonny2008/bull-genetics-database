import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, SEXES, ID_TYPES, label, COUNTRIES } from "@/lib/constants";
import { SireClassBadges } from "@/components/SireFilters";
import { activityLabel } from "@/lib/sire-class";
import { PageHeader, Card, Badge, Table, EmptyState, statusTone } from "@/components/ui";
import { fmtDate, fmtNum } from "@/lib/format";
import { loadRankMap, pickPreferred } from "@/lib/priority";
import { qualityFlagsFor } from "@/lib/quality";
import { matchExistingAnimals } from "@/lib/quality";
import { archiveAnimal, addNote } from "../actions";
import { LinearGraph, type LinearGroup, type LinearTraitDatum } from "@/components/LinearGraph";
import { computeRollback, ratingVerdict, ROLLBACK_TRAIT_LABELS } from "@/lib/rollback";
import { attachTraits, traitDefMap } from "@/lib/eval-traits";

export const dynamic = "force-dynamic";

export default async function AnimalProfile({ params }: { params: { id: string } }) {
  const user = currentUser();
  const writable = can(user?.role, "animal:write");

  const a = await prisma.animal.findUnique({
    where: { id: params.id },
    include: {
      breed: true,
      identifiers: { orderBy: [{ isPrimary: "desc" }, { idType: "asc" }], include: { source: true } },
      evaluations: { orderBy: { evaluationDate: "desc" }, include: { source: true } },
      milkRecords: { orderBy: { recordDate: "desc" }, include: { source: true } },
      classifications: { orderBy: { classificationDate: "desc" }, include: { traitValues: { orderBy: { displayOrder: "asc" } }, source: true } },
      animalNotes: { orderBy: { createdAt: "desc" }, include: {} },
      pedigreeRefs: { include: { source: true } },
      pedigreeIndex: { orderBy: { createdAt: "desc" } },
      captures: { orderBy: { capturedAt: "desc" }, include: { source: true } },
    },
  });
  if (!a) notFound();

  // Rebuild the familiar traitValues[] array from packed storage.
  const defMap = await traitDefMap();
  const evaluations = attachTraits(a.evaluations, defMap);

  // Live preferred resolution + reasons.
  const [geRank, mkRank, clRank] = await Promise.all([
    loadRankMap("genetic_evaluation", a.breedId),
    loadRankMap("milk_record", a.breedId),
    loadRankMap("classification", a.breedId),
  ]);
  const prefProof = pickPreferred(evaluations, {
    getSourceId: (e) => e.sourceId, getDate: (e) => e.evaluationDate, getApproval: (e) => e.approvalStatus,
    rankMap: geRank, domainLabel: "genetic evaluations",
  });
  const prefClass = pickPreferred(a.classifications, {
    getSourceId: (c) => c.sourceId, getDate: (c) => c.classificationDate, getApproval: (c) => c.approvalStatus,
    rankMap: clRank, domainLabel: "classification",
  });

  const quality = qualityFlagsFor(a as any);
  const dupes = (await matchExistingAnimals({
    name: a.primaryName,
    identifiers: a.identifiers.map((i) => ({ idType: i.idType, idValue: i.idValue })),
    breedId: a.breedId, sex: a.sex,
  })).filter((d) => d.id !== a.id);

  const primary = a.identifiers.find((i) => i.isPrimary);
  const preferredEvalId = prefProof.chosen?.evaluationId;
  const preferredClassId = prefClass.chosen?.classificationId;

  // Group preferred proof trait values by category (exclude linear traits — they
  // get their own graph below).
  const linearDefs = await prisma.traitDefinition.findMany({ where: { domain: "genetic", isLinear: true } });
  const linDef = new Map(linearDefs.map((d) => [d.traitCode, d]));
  const prefTraits = prefProof.chosen?.traitValues ?? [];
  const byCat = new Map<string, typeof prefTraits>();
  for (const t of prefTraits) {
    if (linDef.has(t.traitCode)) continue;
    const c = t.traitCategory ?? "Other";
    const arr = byCat.get(c) ?? [];
    arr.push(t);
    byCat.set(c, arr);
  }

  // Build the linear conformation graph from the preferred proof's linear values.
  const linByGroup = new Map<string, { order: number; datum: LinearTraitDatum }[]>();
  for (const tv of prefTraits) {
    const d = linDef.get(tv.traitCode);
    if (!d || tv.numericValue == null) continue;
    const g = d.graphGroup ?? "Type";
    const arr = linByGroup.get(g) ?? [];
    arr.push({ order: d.displayOrder, datum: { name: d.traitName, value: tv.numericValue, min: d.graphMin ?? -15, max: d.graphMax ?? 15, left: d.leftLabel ?? "", right: d.rightLabel ?? "", descriptor: tv.textValue } });
    linByGroup.set(g, arr);
  }
  const GROUP_ORDER = ["Dairy Strength", "Rump", "Feet & Legs", "Mammary System"];
  const linearGroups: LinearGroup[] = [...linByGroup.entries()]
    .map(([group, arr]) => ({ group, traits: arr.sort((x, y) => x.order - y.order).map((x) => x.datum) }))
    .sort((x, y) => (GROUP_ORDER.indexOf(x.group) + 99) - (GROUP_ORDER.indexOf(y.group) + 99));

  // Proof Performance is self-contained, so it is computed live from this bull's
  // rounds. Rollback Resistance is comparative — it needs the whole active
  // lineup's spread — so it is read from the materialised column that
  // prisma/compute-rollback.ts writes after each import.
  const rollback = computeRollback(evaluations.map((e) => ({ evaluationDate: e.evaluationDate, proofRun: e.proofRun, reliabilityOverall: e.reliabilityOverall, traitValues: e.traitValues })));
  const rbVerdict = a.rollbackResistance != null ? ratingVerdict(a.rollbackResistance) : null;

  return (
    <div>
      <PageHeader
        title={a.primaryName}
        subtitle={`${a.breed?.breedName ?? "No breed"} · ${SEXES[a.sex as keyof typeof SEXES] ?? a.sex}${a.shortName ? ` · "${a.shortName}"` : ""}`}
        actions={
          <div className="flex gap-2">
            <Link href={`/comparison?ids=${a.id}`} className="btn-secondary">Compare</Link>
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

      {/* Header facts + quality */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Overview" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
            <Fact k="Internal system ID" v={<span className="font-mono text-xs">{a.id}</span>} />
            <Fact k="Breed" v={a.breed?.breedName ?? "—"} />
            <Fact k="Sex" v={SEXES[a.sex as keyof typeof SEXES] ?? a.sex} />
            <Fact k="Birth date" v={fmtDate(a.birthDate)} />
            <Fact k="Country" v={label(COUNTRIES, a.countryOfOrigin)} />
            <Fact k="Status" v={<Badge>{a.currentStatus}</Badge>} />
            <Fact k="Primary identifier" v={primary ? <span className="font-mono text-xs">{primary.idValue}</span> : "—"} />
            <Fact k="Sire role" v={
              a.sireType || a.proofStatus
                ? <SireClassBadges sireType={a.sireType} proofStatus={a.proofStatus} rollbackCount={a.rollbackCount} proofRoundCount={a.proofRoundCount} activityCode={a.latestActivityCode} />
                : <span className="text-slate-400" title="Set on proof import — this animal has no approved genetic proof yet.">not classified</span>
            } />
            <Fact k="Proof rounds" v={a.proofRoundCount ? `${a.proofRoundCount}${a.latestProofRun ? ` · latest ${a.latestProofRun}` : ""}` : "—"} />
            <Fact k="Rollbacks (April base changes)" v={
              a.rollbackCount
                ? <span title={`${a.rollbackCount} of this sire's ${a.proofRoundCount} rounds are April base changes. Every other round carries updated information.`}>{a.rollbackCount}× of {a.proofRoundCount}</span>
                : "0"
            } />
            <Fact k="Lactanet activity code" v={a.latestActivityCode ? <span title={activityLabel(a.latestActivityCode) ?? undefined}><span className="font-mono">{a.latestActivityCode}</span> — {activityLabel(a.latestActivityCode) ?? "unknown"}</span> : "—"} />
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

      {/* Latest preferred genetic proof */}
      <div className="mt-4">
        <Card
          title="Latest preferred genetic proof"
          actions={writable ? <Link href={`/animals/${a.id}/proofs/new`} className="link text-xs">+ Add proof</Link> : undefined}
        >
          {!prefProof.chosen ? (
            <EmptyState message="No approved genetic proof on file." />
          ) : (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="green">Preferred</Badge>
                <span className="font-medium">{prefProof.chosen.source?.sourceName ?? "—"}</span>
                <span className="text-slate-400">·</span>
                <span>{prefProof.chosen.proofRun ?? fmtDate(prefProof.chosen.evaluationDate)}</span>
                {prefProof.chosen.reliabilityOverall != null && <><span className="text-slate-400">·</span><span>Rel {(prefProof.chosen.reliabilityOverall * 100).toFixed(0)}%</span></>}
              </div>
              <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <span className="font-semibold">Why preferred:</span> {prefProof.reason}
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
            </div>
          )}
        </Card>
      </div>

      {/* Proof-to-proof rollback resistance */}
      <div className="mt-4">
        <Card title="Proof Performance · Rollback Resistance">
          {!rollback.hasHistory ? (
            <div className="text-sm text-slate-600">
              <div className="mb-1"><Badge tone="slate">Single proof round</Badge> on file{rollback.rounds[0] ? ` (${rollback.rounds[0].label})` : ""}.</div>
              <p className="text-slate-500">Both scores calculate automatically once an <strong>earlier or later</strong> proof round is imported for this bull — import another round&apos;s Lactanet file (e.g. an earlier December run) and this fills in with per-trait retention. Rollback Resistance additionally needs at least one <strong>April</strong> round, since that is the base change it measures.</p>
            </div>
          ) : (
            <div>
              <div className="mb-4 flex flex-wrap items-center gap-6">
                {/* Proof Performance — absolute, every round. */}
                <div className="flex items-center gap-3">
                  <div className={`flex h-16 w-16 flex-col items-center justify-center rounded-lg text-white ${rollback.verdict.tone === "good" ? "bg-brand-600" : rollback.verdict.tone === "warn" ? "bg-amber-500" : "bg-red-600"}`}>
                    <span className="text-2xl font-bold leading-none">{rollback.proofPerformance}</span>
                    <span className="text-[9px] uppercase tracking-wide">/ 100</span>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">Proof Performance</div>
                    <Badge tone={rollback.verdict.tone === "good" ? "green" : rollback.verdict.tone === "warn" ? "amber" : "red"}>{rollback.verdict.label}</Badge>
                    <div className="mt-1 text-[11px] text-slate-400">
                      Every round · {rollback.proofSteps} step{rollback.proofSteps === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>

                {/* Rollback Resistance — comparative, April rounds only. Read from
                    the materialised column so the whole lineup does not have to be
                    re-scored on a profile view. */}
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
                  <div className="mt-0.5">Change basis: {rollback.progeny === "progeny" ? "progeny-driven (reliability rose — daughters added)" : rollback.progeny === "genomic" ? "genomic re-evaluation (reliability stable)" : "reliability trend unavailable"}</div>
                  <div className="mt-0.5">100 = average of sires with the same number of April rounds · 5 points = 1 standard deviation</div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="th">Trait</th>
                      <th className="th">First</th>
                      <th className="th">Latest</th>
                      <th className="th">Change</th>
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
              <p className="mt-3 text-[11px] text-slate-400">
                Retention per step = clamp(100 + %change, 0, 100) — 100 held or gained, 50 lost half.
                <strong> Proof Performance</strong> averages every consecutive pair of rounds;
                <strong> April only</strong> averages just the steps into an April base change, and is what
                Rollback Resistance is built from. Trait weights: LPI 32 · Conformation 22 · Milk 16 · Fat 8 ·
                Protein 8 · remaining traits 12.
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* Linear conformation graph (like a proof's linear) */}
      {linearGroups.length > 0 && (
        <div className="mt-4">
          <Card title="Linear conformation profile" actions={<span className="text-xs text-slate-400">{prefProof.chosen?.proofRun ?? ""} · {prefProof.chosen?.source?.sourceName ?? ""}</span>}>
            <LinearGraph groups={linearGroups} />
          </Card>
        </div>
      )}

      {/* Identifiers + Roles */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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

        <Card title="Sire role — how it was derived">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Fact k="Class" v={
              a.sireType
                ? `${a.sireType === "proven" ? "Proven" : "Genomic"} — ${a.sireType === "proven" ? "has daughter-based EBVs" : "GPA genomics only, not yet proven"}`
                : "Not classified (no approved proof)"
            } />
            <Fact k="Status" v={
              a.proofStatus === "active" ? "Active — appears in the most recent round on file"
                : a.proofStatus === "inactive" ? "Inactive — latest proof predates the most recent round"
                : "—"
            } />
            <Fact k="Latest proof" v={a.latestProofRun ?? (a.latestProofDate ? fmtDate(a.latestProofDate) : "—")} />
            <Fact k="Lactanet code" v={a.latestActivityCode ? `${a.latestActivityCode} — ${activityLabel(a.latestActivityCode) ?? "unknown"}` : "—"} />
          </dl>
          <p className="mt-3 text-[11px] text-slate-400">
            Both axes are recomputed on every proof import from Lactanet&apos;s published bull-proof file layout
            (proof activity code, column 24). They are not hand-editable.
          </p>
        </Card>
      </div>

      {/* Genetic proof history */}
      <div className="mt-4">
        <Card title={`Genetic proof history (${evaluations.length})`} actions={writable ? <Link href={`/animals/${a.id}/proofs/new`} className="link text-xs">+ Add proof</Link> : undefined}>
          {evaluations.length === 0 ? <EmptyState message="No proofs recorded." /> : (
            <div className="space-y-3">
              {evaluations.map((e) => (
                <details key={e.evaluationId} className="rounded-md border border-slate-200" open={e.evaluationId === preferredEvalId}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">{e.proofRun ?? fmtDate(e.evaluationDate)}</span>
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
                        <span key={t.traitCode} className="text-slate-600">
                          {t.traitName}: <span className="font-medium text-slate-800">{t.numericValue ?? t.textValue ?? "—"}</span>
                        </span>
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

      {/* Milk + Classification */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={`Milk record history (${a.milkRecords.length})`} actions={writable ? <Link href={`/animals/${a.id}/milk/new`} className="link text-xs">+ Add milk record</Link> : undefined}>
          {a.milkRecords.length === 0 ? <EmptyState message="No milk records." /> : (
            <Table head={<><th className="th">Date</th><th className="th">Lact</th><th className="th">Milk</th><th className="th">Fat</th><th className="th">Prot</th><th className="th">Source</th><th className="th">Pref</th></>}>
              {a.milkRecords.map((m) => (
                <tr key={m.milkRecordId}>
                  <td className="td">{fmtDate(m.recordDate)}</td>
                  <td className="td">{m.lactationNumber ?? "—"}</td>
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

        <Card title={`Classification history (${a.classifications.length})`} actions={writable ? <Link href={`/animals/${a.id}/classification/new`} className="link text-xs">+ Add classification</Link> : undefined}>
          {a.classifications.length === 0 ? <EmptyState message="No classification records." /> : (
            <div className="space-y-2">
              {a.classifications.map((c) => (
                <details key={c.classificationId} className="rounded-md border border-slate-200" open={c.classificationId === preferredClassId}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">{c.classificationCode ?? "—"} {c.finalScore ?? ""}</span>
                    <span className="text-slate-400">·</span>
                    <span>{fmtDate(c.classificationDate)}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500">{c.source?.sourceName ?? "—"}</span>
                    {c.classificationId === preferredClassId && <Badge tone="green">preferred</Badge>}
                  </summary>
                  <div className="border-t border-slate-100 p-3 text-sm">
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                      {c.traitValues.map((t) => (
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

      {/* Source history + Pedigree */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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

        <Card title="Pedigree">
          {a.pedigreeRefs.length === 0 ? (
            <EmptyState message="No pedigree reference yet. Phase 1 links pedigree from official sources." />
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
                  {p.notes && <div className="text-xs text-slate-500">{p.notes}</div>}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 rounded-md border border-dashed border-slate-300 bg-slate-50 p-2 text-xs text-slate-500">
            <span className="font-semibold">Future pedigree index (placeholder):</span>{" "}
            {a.pedigreeIndex.length && a.pedigreeIndex[0].indexValue != null
              ? `${a.pedigreeIndex[0].indexValue} (v${a.pedigreeIndex[0].algorithmVersion})`
              : "Not calculated in Phase 1. Hook is in place for a future pedigree-index engine."}
          </div>
        </Card>
      </div>

      {/* Notes */}
      <div className="mt-4">
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
