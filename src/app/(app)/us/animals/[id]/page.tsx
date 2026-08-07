import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can, ID_TYPES, SEXES, label as labelOf } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, StatCard, Badge, Table, EmptyState, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { US_KEY_TRAITS, formatUsTrait, type UsKeyTrait } from "@/lib/us-cdcb/key-traits";
import { cdcbRoundLabel, cdcbRunKindLabel, type CdcbRunKind } from "@/lib/us-cdcb/file-kind";
import { computeTpi, TpiUnavailable, type TpiResult, type TpiInputKey } from "@/lib/us-cdcb/index-registry";
import { computeJpi, JpiUnavailable, type JpiResult } from "@/lib/us-cdcb/jpi";
import { US_SPECIALIST_CATALOG, type UsSpecialistDirection } from "@/lib/us-cdcb/specialists";
import { parseId17 } from "@/lib/us-cdcb/identity";
import CrossSystemBanner from "@/components/CrossSystemBanner";
import { LinearGraph } from "@/components/LinearGraph";
import { usLinearGroups } from "@/lib/us-cdcb/linear";
// Favourites are ANIMAL-level (Watchlist keyed userId+animalId, with no system on
// it), so this is the same star the Canadian card shows. A bull starred on one
// side is starred on the other — which is the point: one animal, two evaluations.
import FavouriteStar from "@/components/FavouriteStar";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// The American sire card.
//
// Reads UsEvaluation ONLY. The Canadian side is touched in exactly one place —
// <CrossSystemBanner>, which asks GeneticEvaluation whether this bull has rounds
// at all and reports the count and the newest round's label so the page can link
// to /animals/[id]. Not a single Canadian VALUE is read or rendered here. A
// Lactanet EBV is in kilograms and a CDCB PTA is in pounds, so one leaking into
// an American column would be a silent factor-of-two error on a page people buy
// semen from.
//
// Only runKind='official' rows are shown. CDCB's monthly and weekly adds are
// provisional — every Ayrshire bull first published in Feb 2026 had a different
// GPTA by the April round — so they are counted and named but never rendered as
// a proof or ranked beside a round.
//
// The tab set deliberately mirrors the Canadian card (Main / Genetics / Type /
// Round history / Provenance against Main / Genetics / Conformation / …) so that
// hitting the CA|US toggle lands on the same kind of page in the other vocabulary.
// ---------------------------------------------------------------------------

const GTPI_DISCLAIMER =
  "Calculated by Blondin Sires from CDCB evaluations using the Holstein Association USA formula in force " +
  "for each round. Not an official Holstein Association USA publication. Typically within ±3 points. " +
  "TPI is a registered trademark of Holstein Association USA.";

const JPI_DISCLAIMER =
  "Calculated by Blondin Sires from CDCB evaluations using the American Jersey Cattle Association formula " +
  "in force for each round. Not an official AJCA publication. AJCA does not publish JPI for crossbreds.";

const TABS = [
  { code: "main", label: "Main" },
  { code: "genetics", label: "Genetics" },
  { code: "type", label: "Type" },
  { code: "history", label: "Round history" },
  { code: "provenance", label: "Provenance" },
] as const;

export default async function UsSireCard({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: Record<string, string | undefined>;
}) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  // THE ID IN THE URL MAY BE EITHER SIDE'S. The nav toggle is a pure function of
  // the pathname — it cannot query — so when it carries a bull across from
  // /animals/<canadian-id> it hands that id straight to this page. Accepting the
  // American key, the CDCB id17, and the Canadian id keeps the toggle a one-click
  // move instead of a lookup, and makes /us/animals/<id17> a usable URL to type.
  const usAnimal = await prisma.usAnimal.findFirst({
    where: {
      archived: false,
      OR: [{ usAnimalId: params.id }, { id17: params.id }, { animalId: params.id }],
    },
    select: {
      usAnimalId: true, id17: true, name: true, sex: true, birthDate: true,
      naabCode: true, breedCode: true, sire17: true, dam17: true, animalId: true,
      // The Canadian record, when this bull has one. Its absence is the ordinary
      // case and is not an error: most American bulls are not Canadian bulls.
      animal: {
        select: {
          id: true, primaryName: true, shortName: true,
          breed: { select: { breedName: true } },
          identifiers: {
            orderBy: [{ isPrimary: "desc" }, { idType: "asc" }],
            select: { identifierId: true, idType: true, idValue: true, isPrimary: true, source: { select: { sourceName: true } } },
          },
        },
      },
    },
  });
  if (!usAnimal) notFound();

  // A shape the rest of the page can read the way it always has, with the
  // American roster as the source of identity and the Canadian row as the extra.
  const animal = {
    id: usAnimal.usAnimalId,
    primaryName: usAnimal.name ?? usAnimal.id17,
    shortName: usAnimal.animal?.shortName ?? null,
    sex: usAnimal.sex ?? "M",
    birthDate: usAnimal.birthDate,
    breed: usAnimal.animal?.breed ?? (usAnimal.breedCode ? { breedName: usAnimal.breedCode } : null),
    identifiers: usAnimal.animal?.identifiers ?? [],
  };

  const isFav = user && usAnimal.animalId
    ? !!(await prisma.watchlist.findUnique({
        where: { userId_animalId: { userId: user.uid, animalId: usAnimal.animalId } },
        select: { id: true },
      }))
    : false;

  let us: UsData = { rounds: [], betweenRoundRows: 0, betweenRoundLatest: null, aiStatuses: [], missingTables: false };
  try {
    us = await loadUs(usAnimal.usAnimalId, usAnimal.id17);
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run this is a
    // setup state, not a fault — say so rather than rendering a 500.
    if (isMissingTable(e)) {
      us.missingTables = true;
    } else throw e;
  }

  // The preferred row is recomputed by recomputeUsPreferred() over official rows
  // only. Falling back to the newest round keeps the card working for an animal
  // imported before that recompute ran.
  const pref = us.rounds.find((r) => r.isPreferred) ?? us.rounds[0] ?? null;

  const backLinks = (
    <div className="flex flex-wrap items-center gap-2">
      <FavouriteStar animalId={animal.id} initial={isFav} size="lg" />
      <Link href="/us/animals" className="btn-secondary btn-sm">‹ American lineup</Link>
      <Link href={`/us/compare?bulls=${animal.id}`} className="btn-secondary btn-sm">Compare</Link>
    </div>
  );

  // Says whether this same bull is also evaluated in Canada and links straight to
  // his Canadian card. Existence, count and round label only — never a value.
  const crossSystem = <CrossSystemBanner animalId={animal.id} system="us" />;

  if (us.missingTables) {
    return (
      <div>
        <PageHeader title={animal.primaryName} subtitle="CDCB evaluation" actions={backLinks} />
        {crossSystem}
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run db:push:prod</pre>
          <p className="mt-3 text-sm text-slate-600">Then import a CDCB round:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      </div>
    );
  }

  if (!pref) {
    return (
      <div>
        <PageHeader title={animal.primaryName} subtitle="No CDCB evaluation" actions={backLinks} />
        {crossSystem}
        <EmptyState message="This animal has no official CDCB round on file.">
          <div className="space-y-2 text-xs text-slate-500">
            {us.betweenRoundRows > 0 && (
              <p>
                He does carry {us.betweenRoundRows} between-round CDCB row{us.betweenRoundRows === 1 ? "" : "s"} —
                a monthly or weekly add. Those values are provisional and are superseded at the next official
                round, so they are not shown as a proof.
              </p>
            )}
            <p>
              A US evaluation appears here once a CDCB round is imported that contains him, or once his
              Canadian registration is matched to a CDCB id.
            </p>
          </div>
        </EmptyState>
      </div>
    );
  }

  const tab = TABS.find((t) => t.code === searchParams.tab)?.code ?? "main";
  const tabHref = (t: string) => (t === "main" ? `/us/animals/${animal.id}` : `/us/animals/${animal.id}?tab=${t}`);

  const gpta = parseMap(pref.gptaJson);
  const rel = parseMap(pref.relJson);
  const dgv = parseMap(pref.dgvJson);
  const pa = parseMap(pref.paJson);
  const haplotypes = parseStringMap(pref.haplotypesJson);
  const groups = groupTraits(gpta, dgv, pa);
  const isJersey = pref.evalBreed === "JE";
  const aiStatus = us.aiStatuses.find((s) => s.roundCode === pref.roundCode)?.code ?? null;

  // --- The calculated index, recomputed live so its inputs can be shown --------
  // computeTpi/computeJpi resolve the formula that was in force FOR THIS ROUND and
  // throw rather than fall back to the current one. The stored column is what the
  // importer wrote; recomputing here is what lets the page show the sub-index
  // inputs behind the number rather than simply asserting the number.
  const indexCalc = computeIndex(isJersey, gpta, pref.roundCode);

  // Sire and dam are CDCB id17s. Where we already hold that animal the id links to
  // his American card — a pedigree fact, never a borrowed evaluation.
  const parentLinks = await resolveParents(pref.sire17, pref.dam17);

  const id17Parts = parseId17(pref.id17);
  const primaryId = animal.identifiers.find((i) => i.isPrimary) ?? null;
  const naab = pref.naabCode ?? animal.identifiers.find((i) => i.idType === "naab")?.idValue ?? null;

  return (
    <div>
      <PageHeader
        title={animal.primaryName}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {naab && <span className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-xs font-medium text-brand-700">NAAB {naab}</span>}
            <span className="font-mono text-xs text-slate-500" title="CDCB 17-character identifier">{pref.id17}</span>
            <span>{breedName(pref.evalBreed) ?? animal.breed?.breedName ?? "breed not stated"}</span>
            <span>{SEXES[animal.sex as keyof typeof SEXES] ?? animal.sex}</span>
            <span>born {fmtDate(animal.birthDate)}</span>
            <Badge tone="blue">{roundLabel(pref.roundCode)} · official</Badge>
            {aiStatus && <Badge tone="brand">{AI_STATUS_LABELS[aiStatus]?.short ?? aiStatus}</Badge>}
            {pref.isGraduation && <Badge tone="amber">graduation round</Badge>}
            {pref.approvalStatus !== "approved" && <Badge tone={statusTone(pref.approvalStatus)}>{pref.approvalStatus}</Badge>}
          </span>
        }
        actions={backLinks}
      />

      {crossSystem}

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

      {/* ===================== MAIN ===================== */}
      {tab === "main" && (
        <div className="space-y-4">
          {/* --- The big numbers ------------------------------------------- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {isJersey ? (
              <StatCard
                label="JPI (calculated)"
                value={pref.jpi ?? "—"}
                hint={pref.jpiFormulaVersion ? `${pref.jpiFormulaVersion} formula` : "not computable for this round"}
                tone="accent"
              />
            ) : (
              <StatCard
                label="GTPI (calculated)"
                value={pref.tpi ?? "—"}
                hint={pref.tpiFormulaVersion ? `${pref.tpiFormulaVersion} formula` : "formula not verified for this round"}
                tone="accent"
              />
            )}
            <StatCard label="Net Merit" value={pref.nmDollar == null ? "—" : `$${Math.round(pref.nmDollar)}`} hint="CDCB published, in dollars" />
            <StatCard label="PTAT" value={pref.ptat == null ? "—" : pref.ptat.toFixed(2)} hint="CDCB published type" />
            <StatCard
              label="Production basis"
              value={pref.isPtaMilk === true ? "Daughters" : pref.isPtaMilk === false ? "Parent avg" : "—"}
              hint={pref.isPtaMilk === true ? "real daughter-based PTA" : pref.isPtaMilk === false ? "no daughters yet" : "not stated"}
              tone={pref.isPtaMilk === true ? "good" : "default"}
            />
          </div>

          {/* --- The seven lead traits ------------------------------------- */}
          <Card title="US key traits">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {US_KEY_TRAITS.map((t) => (
                <div key={t.code} className="rounded-md border border-slate-200 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t.short}</div>
                  <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{keyTraitValue(t, pref)}</div>
                  <div className="mt-1 text-[11px] leading-tight text-slate-400">
                    {t.direction === "intermediate" ? (
                      <span className="font-medium text-amber-700">Intermediate optimum — not ranked</span>
                    ) : t.source === "computed" ? (
                      "calculated, not published"
                    ) : (
                      `reliability ${rel[t.code] != null ? `${rel[t.code]}%` : "—"}`
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Rump Angle has an <strong>intermediate optimum</strong>: neither the highest nor the lowest value is
              the best one, so it is shown but never sorted, ranked or scored as higher-is-better. Every yield
              figure is a PTA in <strong>pounds</strong>.
            </p>
          </Card>

          {/* --- Identity --------------------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Identity" className="lg:col-span-2">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
                <Fact k="Name" v={animal.primaryName} />
                {animal.shortName && <Fact k="Short name" v={animal.shortName} />}
                <Fact k="Sex" v={SEXES[animal.sex as keyof typeof SEXES] ?? animal.sex} />
                <Fact k="Birth date" v={fmtDate(animal.birthDate)} />
                <Fact
                  k="Evaluation breed"
                  v={
                    <span title="EVAL_BREED — the breed CDCB evaluated him in">
                      {pref.evalBreed ? `${breedName(pref.evalBreed)} (${pref.evalBreed})` : "—"}
                    </span>
                  }
                />
                <Fact
                  k="Registry breed"
                  v={id17Parts ? <span title="The breed segment of the id17 — the herdbook he is recorded in">{breedName(id17Parts.breed)} ({id17Parts.breed})</span> : "—"}
                />
                <Fact k="Registry country" v={id17Parts ? <span className="font-mono text-xs">{id17Parts.country}</span> : "—"} />
                <Fact k="CDCB id (id17)" v={<span className="font-mono text-xs">{pref.id17}</span>} />
                <Fact k="Herdbook number" v={id17Parts ? <span className="font-mono text-xs">{id17Parts.number}</span> : "—"} />
                <Fact k="NAAB code" v={naab ? <span className="font-mono text-xs">{naab}</span> : "—"} />
                <Fact k="Primary identifier" v={primaryId ? <span className="font-mono text-xs">{primaryId.idValue}</span> : "—"} />
                <Fact k="Internal system ID" v={<span className="font-mono text-[10px] text-slate-400">{animal.id}</span>} />
              </dl>
              <p className="mt-3 text-[11px] text-slate-400">
                The id17 is CDCB&rsquo;s 17-character identifier: two characters of breed, three of country, twelve
                of herdbook number. Its breed segment is the <em>registry</em> breed and is not always the breed the
                animal was evaluated in — 549 animals in the April 2026 Holstein file carry a non-HO prefix — so the
                two are shown separately rather than merged.
              </p>
            </Card>

            <Card title="Parents (CDCB)">
              <dl className="space-y-2 text-sm">
                <Row k="Sire (SIRE17)" v={<ParentValue id17={pref.sire17} link={parentLinks.sire} />} />
                <Row k="Dam (DAM17)" v={<ParentValue id17={pref.dam17} link={parentLinks.dam} />} />
              </dl>
              <p className="mt-3 text-xs text-slate-500">
                These are the id17s CDCB records on this evaluation. Where we already hold that animal the id links
                to his American card; where we do not, the raw id is printed rather than a guess at a name.
              </p>
            </Card>
          </div>

          {/* --- AI status --------------------------------------------------- */}
          <Card title="AI status for this round">
            {aiStatus ? (
              <div>
                <div className="flex items-center gap-3">
                  <span className="rounded-md bg-brand-600 px-3 py-1.5 font-mono text-lg font-bold text-white">{aiStatus}</span>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{AI_STATUS_LABELS[aiStatus]?.short ?? "Undocumented code"}</div>
                    <div className="text-xs text-slate-500">{AI_STATUS_LABELS[aiStatus]?.long ?? "This app holds no documented meaning for this code, so it is printed as published."}</div>
                  </div>
                </div>
                <dl className="mt-4 space-y-2 text-sm">
                  {Object.entries(AI_STATUS_LABELS).map(([code, m]) => (
                    <Row key={code} k={`${code} — ${m.short}`} v={<span className="text-xs font-normal text-slate-500">{m.long}</span>} />
                  ))}
                </dl>
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                CDCB published no AI status for this animal in the {roundLabel(pref.roundCode)} round. That is an
                absence of a listing, not a statement that he is unavailable.
              </p>
            )}
            <p className="mt-3 text-xs text-slate-500">
              AI status is published <strong>per round</strong>, so it is a fact about this round and not a permanent
              property of the bull. It is CDCB&rsquo;s answer to &ldquo;is he actually being marketed&rdquo; —
              carrying a NAAB code is not that answer. Every round on file is listed on the Provenance tab.
            </p>
          </Card>
        </div>
      )}

      {/* ===================== GENETICS ===================== */}
      {tab === "genetics" && (
        <div className="space-y-4">
          {/* --- Proven or genomic, and inbreeding ------------------------- */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Proven or genomic">
              <dl className="space-y-2 text-sm">
                <Row k="Production (IS_PTA_MILK)" v={pref.isPtaMilk === true ? "Daughter-based PTA" : pref.isPtaMilk === false ? "Parent average" : "not stated"} />
                <Row k="Calving (IS_PTA_CT)" v={pref.isPtaCt === true ? "Daughter-based PTA" : pref.isPtaCt === false ? "Parent average" : "not stated"} />
                <Row k="Graduation round" v={pref.isGraduation ? "Yes — his first daughter proof" : "No"} />
                <Row k="Blend code" v={pref.blendCode === "S" ? "S — straightbred" : pref.blendCode === "M" ? "M — crossbred" : pref.blendCode ?? "—"} />
                <Row k="Genotyping chip" v={pref.chip ?? "—"} />
                <Row k="Evaluation date" v={fmtDate(pref.evaluationDate)} />
              </dl>
              <p className="mt-3 text-xs text-slate-500">
                CDCB answers proven-vs-genomic <strong>per trait group, not per animal</strong>. A bull can be
                daughter-proven for production and still carry a parent average for calving, so the two flags are
                read separately and neither one describes the whole evaluation. There is deliberately no single
                &ldquo;proven&rdquo; or &ldquo;genomic&rdquo; badge for a bull on this side: it would flatten a
                distinction CDCB makes on purpose.
              </p>
            </Card>

            <Card title="Inbreeding">
              <dl className="space-y-2 text-sm">
                <Row k="Genomic (GEN_INB)" v={pct(pref.genInb)} />
                <Row k="Pedigree (PED_INB)" v={pct(pref.pedInb)} />
                <Row k="Genomic future (GEN_FUT_INB)" v={pct(pref.genFutInb)} />
                <Row k="Expected future (EXP_FUT_INB)" v={pct(pref.expFutInb)} />
              </dl>
              <p className="mt-3 text-xs text-slate-500">
                These are four different measures and <strong>must not be averaged or compared with each
                other</strong>. The first two are <em>this animal&rsquo;s own</em> inbreeding — one read from his
                genotype, one from his recorded pedigree. The last two are forward-looking: the inbreeding expected
                in his progeny from matings to the current population, again genomic and pedigree respectively. A
                genomic figure that differs from the pedigree one is normal and is not an error in either.
              </p>
            </Card>
          </div>

          {/* --- Behind the calculated index -------------------------------- */}
          <Card title={isJersey ? "Behind the JPI — the inputs and the arithmetic" : "Behind the GTPI — the sub-indexes and the arithmetic"}>
            <IndexBreakdown
              calc={indexCalc}
              isJersey={isJersey}
              stored={isJersey ? pref.jpi : pref.tpi}
              storedVersion={isJersey ? pref.jpiFormulaVersion : pref.tpiFormulaVersion}
              storedConfidence={pref.tpiConfidence}
              roundCode={pref.roundCode}
            />
          </Card>

          {/* --- Everything CDCB publishes for him -------------------------- */}
          <Card title="Every published trait">
            <p className="mb-3 text-xs text-slate-500">
              <strong>GPTA</strong> is the published evaluation — the number to quote. <strong>Rel.</strong> is its
              reliability as a percentage, where CDCB publishes one. <strong>DGV</strong> is the direct genomic
              value, the genomic prediction alone before blending with pedigree and daughter information.{" "}
              <strong>PA</strong> is the parent average, what the pedigree alone predicted. Reading them together
              shows where the genomics agreed with the pedigree and where it did not. The seven lead traits appear
              on the Main tab as well; they are repeated here so their reliability and PA are visible alongside the
              rest. A dash means CDCB published nothing in that cell, which is not the same claim as zero.
            </p>
            {groups.length === 0 ? (
              <EmptyState message="This round carries no trait map for the animal." />
            ) : (
              groups.map((g) => (
                <div key={g.group} className="mb-4 last:mb-0">
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.group}</h3>
                  <TraitTable rows={g.rows} gpta={gpta} rel={rel} dgv={dgv} pa={pa} />
                </div>
              ))
            )}
            <p className="mt-3 text-xs text-slate-500">
              CDCB publishes a fifth column, GSONS, which this app stores but does not show. It is the genomic
              evaluation for producing <em>sons</em>, with X-chromosome effects excluded — the correct input when
              computing a son&rsquo;s parent average, and emphatically not a count of sons.
            </p>
          </Card>

          {/* --- Haplotypes ------------------------------------------------- */}
          <Card title="Haplotypes and genetic conditions">
            {Object.keys(haplotypes).length === 0 ? (
              <p className="text-sm text-slate-600">
                CDCB published no haplotype or genetic-condition call for this animal in the{" "}
                {roundLabel(pref.roundCode)} round. That is an absence of a call, not a clear result.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(haplotypes).map(([code, value]) => (
                    <span key={code} className="rounded-md border border-slate-200 px-2.5 py-1.5 text-sm">
                      <span className="font-mono text-xs font-semibold text-slate-700">{code}</span>
                      <span className="ml-2 tabular-nums text-slate-900">{value}</span>
                    </span>
                  ))}
                </div>
                {/* Codes are shown exactly as CDCB ships them, deliberately. A carrier
                    status drives real mating decisions, and inventing a "carrier"/"free"
                    translation for a code we have not verified against CDCB's own
                    documentation would be a confident wrong answer in the one place
                    that cannot afford it. */}
                <p className="mt-3 text-xs text-slate-500">
                  Shown exactly as CDCB publishes them — the raw code and the raw call, with no re-interpretation
                  by this app. This repository holds no verified code book for these calls, so a value is never
                  translated into &ldquo;carrier&rdquo; or &ldquo;free&rdquo;. Read them against CDCB&rsquo;s
                  genetic-condition documentation for the round before acting on any of them.
                </p>
              </>
            )}
          </Card>
        </div>
      )}

      {/* ===================== TYPE ===================== */}
      {tab === "type" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="PTAT" value={pref.ptat == null ? "—" : pref.ptat.toFixed(2)} hint="CDCB published" />
            <StatCard
              label="UDC (derived)"
              value={pref.udc == null ? "—" : pref.udc.toFixed(2)}
              hint={indexCalc.kind === "tpi" ? indexCalc.result.formula.udc?.label ?? "Udder Composite" : "Udder Composite"}
              tone="accent"
            />
            <StatCard
              label="FLC (derived)"
              value={pref.flc == null ? "—" : pref.flc.toFixed(2)}
              hint={indexCalc.kind === "tpi" ? indexCalc.result.formula.flc?.label ?? "Feet & Legs Composite" : "Feet & Legs Composite"}
              tone="accent"
            />
            <StatCard
              label="BWC (derived)"
              value={indexCalc.kind === "tpi" ? round2(indexCalc.result.composites.bwc) : "—"}
              hint={indexCalc.kind === "tpi" ? indexCalc.result.formula.bwc.label : "needs the TPI formula for this round"}
              tone="accent"
            />
          </div>

          <Card title="The composites are derived, not published">
            <p className="text-sm text-slate-600">
              CDCB does not publish UDC, FLC or BWC. They are <strong>Holstein Association USA composites</strong>,
              and the figures above are computed by Blondin Sires from the CDCB linear traits below using the
              composite formula in force for the {roundLabel(pref.roundCode)} round. They carry the same caveat as
              GTPI: our arithmetic, HAUSA&rsquo;s definition, not an official HAUSA publication.
            </p>
            {indexCalc.kind === "tpi" && (
              <dl className="mt-3 space-y-2 text-sm">
                <Row k="UDC formula" v={indexCalc.result.formula.udc?.label ?? "—"} />
                <Row k="FLC formula" v={indexCalc.result.formula.flc?.label ?? "—"} />
                <Row k="BWC formula" v={indexCalc.result.formula.bwc.label} />
              </dl>
            )}
            <p className="mt-3 text-xs text-slate-500">
              UDC and FLC each penalise a trait on <em>both</em> sides of zero — UDC on teat length, FLC on rear legs
              side view — which is the arithmetic reason those traits are flagged intermediate-optimum below.
            </p>
          </Card>

          <Card title="Linear type profile">
            {(() => {
              const chart = usLinearGroups(gpta);
              if (chart.length === 0) {
                return <EmptyState message="No linear type traits published for this animal in this round." />;
              }
              return <LinearGraph groups={chart} />;
            })()}
            <p className="mt-4 text-xs text-slate-500">
              Plotted on a <strong>−3 … +3</strong> track with breed average at the centre line. CDCB publishes these
              as standardised deviations, so that range covers the working spread of the breed; a bull beyond it is
              drawn at the rail while the figure beside his bar stays the real one. End descriptors are the breed
              vocabulary this application already uses on the Canadian card, so one bull&rsquo;s two cards point
              &ldquo;wide&rdquo; the same way. Favourable direction comes from the app&rsquo;s trait catalogue — green
              is the <em>good</em> end, not merely the positive one, which matters on the traits below where the good
              end is the low one.
            </p>
          </Card>

          <Card title="Linear type traits — published values">
            {(() => {
              const linearGroups = groupLinear(gpta, dgv, pa);
              if (linearGroups.length === 0) {
                return <EmptyState message="No linear type traits published for this animal in this round." />;
              }
              return linearGroups.map((g) => (
                <div key={g.group} className="mb-4 last:mb-0">
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.group}</h3>
                  <TraitTable rows={g.rows} gpta={gpta} rel={rel} dgv={dgv} pa={pa} />
                </div>
              ));
            })()}
            <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <strong>How the directions above were set.</strong> Stature, Rump Angle and Rear Teat Placement are
              <em> intermediate optimum</em> — the same call as the Canadian chart — along with Teat Length, Rear Legs
              side view and Udder Depth. All six are badged <strong>opt</strong>: the middle of the scale is the
              target, so neither end is ranked and neither is shaded good or bad. Dairy Form is the one type trait
              here read directionally, <strong>higher is better</strong>. GTPI is unaffected — Holstein Association
              USA&rsquo;s composite arithmetic is computed exactly as published, including its rear-teat curve,
              because a house preference must not edit someone else&rsquo;s formula.
            </div>
          </Card>
        </div>
      )}

      {/* ===================== ROUND HISTORY ===================== */}
      {tab === "history" && (
        <div className="space-y-4">
          <Card title={`Official CDCB rounds (${us.rounds.length})`}>
            {us.rounds.length === 1 ? (
              <p className="text-sm text-slate-600">
                One official round on file ({roundLabel(pref.roundCode)}). Movement becomes visible from the second
                round onward.
              </p>
            ) : (
              <Table
                head={
                  <>
                    <th className="th">Round</th>
                    <th className="th text-right">{isJersey ? "JPI (calc.)" : "GTPI (calc.)"}</th>
                    <th className="th text-right">NM$</th>
                    <th className="th text-right">PTAT</th>
                    <th className="th">Production</th>
                    <th className="th">Formula</th>
                  </>
                }
              >
                {us.rounds.map((r, i) => {
                  const older = us.rounds[i + 1];
                  const idx = isJersey ? r.jpi : r.tpi;
                  const olderIdx = isJersey ? older?.jpi : older?.tpi;
                  const version = isJersey ? r.jpiFormulaVersion : r.tpiFormulaVersion;
                  const olderVersion = isJersey ? older?.jpiFormulaVersion : older?.tpiFormulaVersion;
                  // A calculated index is only comparable to itself. When the formula
                  // version changed between two rounds the difference is partly the
                  // formula moving, not the bull, so no delta is offered at all.
                  const sameFormula = !!older && !!version && version === olderVersion;
                  return (
                    <tr key={r.usEvaluationId} className="hover:bg-slate-50">
                      <td className="td">
                        <span className="font-medium">{roundLabel(r.roundCode)}</span>
                        {r.isPreferred && <span className="ml-2 align-middle"><Badge tone="green">shown above</Badge></span>}
                        {r.isGraduation && <span className="ml-2 align-middle"><Badge tone="amber">graduation</Badge></span>}
                      </td>
                      <Cell
                        value={idx == null ? "—" : String(idx)}
                        delta={sameFormula ? delta(idx, olderIdx, 0) : null}
                        note={older && !sameFormula ? "formula changed — no delta" : null}
                      />
                      <Cell value={r.nmDollar == null ? "—" : `$${Math.round(r.nmDollar)}`} delta={delta(r.nmDollar, older?.nmDollar, 0)} />
                      <Cell value={r.ptat == null ? "—" : r.ptat.toFixed(2)} delta={delta(r.ptat, older?.ptat, 2)} />
                      <td className="td text-xs text-slate-500">{r.isPtaMilk === true ? "daughters" : r.isPtaMilk === false ? "parent avg" : "—"}</td>
                      <td className="td text-xs text-slate-500">{version ?? "—"}</td>
                    </tr>
                  );
                })}
              </Table>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Official rounds only — CDCB ships one file per round, so there is no interim proof to compare
              against. Differences are raw arithmetic between published figures: CDCB re-bases roughly every five
              years (most recently at the April 2025 round) and every animal&rsquo;s values shift at a re-basing,
              so a change that spans one is not genetic movement. A graduation round — a genomic bull&rsquo;s first
              daughter proof — moves several times a normal round and should be read as a change of evaluation
              type, not as a drop. Where the calculated index was built with a different formula version between
              two rounds, no delta is offered at all, because part of that movement would be the formula rather
              than the bull.
              {us.betweenRoundRows > 0 && (
                <> This animal also has {us.betweenRoundRows} provisional between-round row
                  {us.betweenRoundRows === 1 ? "" : "s"}
                  {us.betweenRoundLatest ? ` (most recent ${us.betweenRoundLatest})` : ""}, which are excluded here.</>
              )}
            </p>
          </Card>

          <Card title="Every value, round by round">
            <div className="space-y-3">
              {us.rounds.map((r) => {
                const rg = parseMap(r.gptaJson);
                const rrel = parseMap(r.relJson);
                const codes = Object.keys(rg).sort(byCatalogue);
                return (
                  <details key={r.usEvaluationId} className="rounded-md border border-slate-200" open={r.usEvaluationId === pref.usEvaluationId}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-medium">{roundLabel(r.roundCode)}</span>
                      <Badge tone="blue">{cdcbRunKindLabel(r.runKind as CdcbRunKind)}</Badge>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500">{r.sourceFamily}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500">{fmtDate(r.evaluationDate)}</span>
                      {r.isGraduation && <Badge tone="amber">graduation</Badge>}
                      <Badge tone={statusTone(r.approvalStatus)}>{r.approvalStatus}</Badge>
                      {r.isPreferred && <Badge tone="green">preferred</Badge>}
                      <span className="text-xs text-slate-400">{codes.length} published trait{codes.length === 1 ? "" : "s"}</span>
                    </summary>
                    <div className="border-t border-slate-100 p-3">
                      {codes.length === 0 ? (
                        <span className="text-sm text-slate-400">No trait map stored for this round.</span>
                      ) : (
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                          {codes.map((code) => {
                            const def = US_TRAITS[code];
                            return (
                              <span key={code} className="text-slate-600">
                                {def?.label ?? code}: <span className="font-medium text-slate-800">{fmtTrait(def, rg[code])}</span>
                                {rrel[code] != null && <span className="ml-1 text-[10px] text-slate-400">rel {rrel[code]}%</span>}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Each block is one official round exactly as it was published. Values are never re-based, adjusted or
              carried forward between rounds.
            </p>
          </Card>
        </div>
      )}

      {/* ===================== PROVENANCE ===================== */}
      {tab === "provenance" && (
        <div className="space-y-4">
          <Card title={`Where the ${roundLabel(pref.roundCode)} evaluation came from`}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row k="Source file" v={<span className="break-all font-mono text-xs">{pref.sourceFile ?? "—"}</span>} />
              <Row k="CDCB file family" v={pref.sourceFamily} />
              <Row k="Run kind" v={`${pref.runKind} — ${cdcbRunKindLabel(pref.runKind as CdcbRunKind)}`} />
              <Row k="Round code" v={pref.roundCode ? `${pref.roundCode} — ${roundLabel(pref.roundCode)}` : "—"} />
              <Row k="Period key" v={<span className="font-mono text-xs">{pref.periodKey}</span>} />
              <Row k="Evaluation date" v={fmtDate(pref.evaluationDate)} />
              <Row k="Date received (DATE_RECEIVED)" v={fmtDate(pref.dateReceived)} />
              <Row k="Genotyping chip (CHIP)" v={pref.chip ?? "—"} />
              <Row k="Blend code" v={pref.blendCode === "S" ? "S — straightbred" : pref.blendCode === "M" ? "M — crossbred" : pref.blendCode ?? "—"} />
              <Row k="Heterosis (HETEROSIS)" v={pref.heterosis == null ? "—" : String(pref.heterosis)} />
              <Row k="Requester id (REQUESTER_ID)" v={pref.requesterId ?? "—"} />
              <Row k="CURRENT flag" v={pref.current == null ? "—" : `${pref.current}${pref.current === "U" ? " — unofficial weekly" : ""}`} />
              <Row k="Approval status" v={pref.approvalStatus} />
              <Row k="Imported into this app" v={fmtDate(pref.createdAt)} />
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              The period key is prefixed (R = triannual round, M = monthly add, W = weekly add) because a monthly
              add and the official round share a YYMM. Without the prefix a provisional row could displace the
              official round for this animal, which is exactly the substitution this card exists to prevent.
            </p>
          </Card>

          <Card title={`AI status history (${us.aiStatuses.length})`}>
            {us.aiStatuses.length === 0 ? (
              <EmptyState message="No CDCB AI-status listing on file for this animal." />
            ) : (
              <Table head={<><th className="th">Round</th><th className="th">Code</th><th className="th">Meaning</th></>}>
                {us.aiStatuses.map((s) => (
                  <tr key={`${s.roundCode}-${s.code}`}>
                    <td className="td">{roundLabel(s.roundCode)}</td>
                    <td className="td font-mono">{s.code}</td>
                    <td className="td text-xs text-slate-500">{AI_STATUS_LABELS[s.code]?.long ?? "No documented meaning for this code — printed as published."}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Between-round rows">
            {us.betweenRoundRows === 0 ? (
              <p className="text-sm text-slate-600">No provisional or weekly CDCB rows are stored for this animal.</p>
            ) : (
              <p className="text-sm text-slate-600">
                {us.betweenRoundRows} between-round row{us.betweenRoundRows === 1 ? "" : "s"} stored
                {us.betweenRoundLatest ? `, the most recent from ${us.betweenRoundLatest}` : ""}. Their values are
                deliberately not rendered anywhere on this card. CDCB&rsquo;s monthly and weekly adds are
                provisional and are superseded at the next official round, so showing them beside a round would
                invite a comparison between two different kinds of number.
              </p>
            )}
          </Card>

          <Card title={`Identifiers (${animal.identifiers.length})`}>
            {animal.identifiers.length === 0 ? (
              <EmptyState message="No identifiers on file." />
            ) : (
              <Table head={<><th className="th">Type</th><th className="th">Value</th><th className="th">Source</th><th className="th">Primary</th></>}>
                {animal.identifiers.map((i) => (
                  <tr key={i.identifierId}>
                    <td className="td">{i.idType === "cdcb_id17" ? "CDCB 17-character id" : labelOf(ID_TYPES, i.idType)}</td>
                    <td className="td font-mono text-xs">{i.idValue}</td>
                    <td className="td text-xs text-slate-500">{i.source?.sourceName ?? "—"}</td>
                    <td className="td">{i.isPrimary ? <Badge tone="green">primary</Badge> : ""}</td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Identifiers are animal-level and shared with the Canadian card — the CDCB id17 and the Canadian
              registration sit on the same record, which is what lets the CA|US toggle carry this bull across.
            </p>
          </Card>
        </div>
      )}

      <p className="mt-5 text-xs text-slate-500">
        <strong>{isJersey ? "JPI" : "GTPI"} is calculated</strong>, not published.{" "}
        {isJersey ? JPI_DISCLAIMER : GTPI_DISCLAIMER}{" "}
        The UDC and FLC composites on the Type tab are derived by Blondin Sires under the same caveat. Every other
        value on this page is a CDCB PTA in <strong>pounds</strong> — roughly half the corresponding Canadian
        breeding value, and never directly comparable to one.
      </p>
    </div>
  );
}

// --- Data -------------------------------------------------------------------

interface UsData {
  rounds: UsRound[];
  /** Monthly and weekly adds. Counted so the page can say they exist, never shown. */
  betweenRoundRows: number;
  betweenRoundLatest: string | null;
  aiStatuses: { roundCode: string; code: string }[];
  missingTables: boolean;
}

type UsRound = Awaited<ReturnType<typeof loadRounds>>[number];

function loadRounds(usAnimalId: string) {
  return prisma.usEvaluation.findMany({
    where: { usAnimalId, runKind: "official", approvalStatus: "approved" },
    orderBy: { evaluationDate: "desc" },
    select: {
      usEvaluationId: true, id17: true, roundCode: true, periodKey: true, sourceFamily: true, runKind: true,
      evaluationDate: true, evalBreed: true, naabCode: true, sire17: true, dam17: true,
      isPreferred: true, isGraduation: true, isPtaMilk: true, isPtaCt: true, blendCode: true, heterosis: true,
      chip: true, requesterId: true, dateReceived: true, current: true,
      genInb: true, pedInb: true, genFutInb: true, expFutInb: true,
      nmDollar: true, ptat: true, udc: true, flc: true,
      tpi: true, tpiFormulaVersion: true, tpiConfidence: true, jpi: true, jpiFormulaVersion: true,
      milk: true, rpa: true, dpr: true, ccr: true,
      gptaJson: true, relJson: true, dgvJson: true, paJson: true, haplotypesJson: true,
      sourceFile: true, approvalStatus: true, createdAt: true,
    },
  });
}

async function loadUs(usAnimalId: string, id17: string): Promise<UsData> {
  const [rounds, betweenRoundRows, betweenLatest, aiStatuses] = await Promise.all([
    loadRounds(usAnimalId),
    prisma.usEvaluation.count({ where: { usAnimalId, runKind: { not: "official" } } }),
    prisma.usEvaluation.findFirst({
      where: { usAnimalId, runKind: { not: "official" } },
      orderBy: { evaluationDate: "desc" },
      select: { periodKey: true },
    }),
    // CDCB's AI-status file is the US answer to "is this bull actually marketed" —
    // carrying a NAAB code is not that answer. It is keyed on the round, so the
    // header shows only the code matching the round on display; the full list is
    // on the Provenance tab.
    // Keyed on id17, not on any animal id: the status file is published
    // independently of the evaluation files, so its rows are matched by CDCB's
    // own identifier rather than by a foreign key that would reject the orphans.
    prisma.usAiStatus.findMany({
      where: { id17 },
      orderBy: { roundCode: "desc" },
      select: { roundCode: true, code: true },
    }),
  ]);
  return {
    rounds,
    betweenRoundRows,
    betweenRoundLatest: betweenLatest?.periodKey ?? null,
    aiStatuses,
    missingTables: false,
  };
}

/** The US tables are created by `prisma db push`; until then their absence is a
 *  setup state, not a fault. Matches Prisma's P2021 and the raw SQL message. */
function isMissingTable(e: unknown): boolean {
  return /does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message));
}

/** Resolve sire/dam id17s to animals we already hold — a pedigree link, never a
 *  borrowed evaluation. */
async function resolveParents(sire17: string | null, dam17: string | null) {
  const ids = [sire17, dam17].filter((x): x is string => !!x);
  const none = { sire: null, dam: null };
  if (ids.length === 0) return none;
  // A parent links ONLY if CDCB evaluated him too and he is therefore already on
  // the American roster. This is the honest version of what the old code did:
  // it resolved through cdcb_id17 identifiers, and the importer manufactured an
  // Animal row for every sire and dam it met so those identifiers would exist —
  // which is how 35,766 unproofed strangers ended up in the Canadian lineup. A
  // named ancestor is a REFERENCE. If he is not evaluated, he gets no row and no
  // link, and the card simply shows his id17.
  const rows = await prisma.usAnimal.findMany({
    where: { id17: { in: ids }, archived: false },
    select: { id17: true, usAnimalId: true, name: true },
  });
  const byId = new Map(rows.map((r) => [r.id17, { animalId: r.usAnimalId, name: r.name }]));
  return {
    sire: sire17 ? byId.get(sire17) ?? null : null,
    dam: dam17 ? byId.get(dam17) ?? null : null,
  };
}

const AI_STATUS_LABELS: Record<string, { short: string; long: string }> = {
  A: {
    short: "Active AI",
    long: "CDCB lists him as an active AI sire for this round — semen is being marketed in the United States.",
  },
  G: {
    short: "Genomic young bull, marketed",
    long: "Marketed on a genomic evaluation, without a daughter proof yet. His figures are a genomic prediction, not a daughter-based PTA.",
  },
  F: {
    short: "Foreign",
    long: "Evaluated in the United States from data supplied by another country rather than from US daughters.",
  },
};

/** CDCB two-letter breed codes, as they appear in EVAL_BREED and the id17 prefix. */
const BREED_NAMES: Record<string, string> = {
  AY: "Ayrshire", BS: "Brown Swiss", GU: "Guernsey", HO: "Holstein", JE: "Jersey", MS: "Milking Shorthorn",
};
function breedName(code: string | null | undefined): string | null {
  if (!code) return null;
  return BREED_NAMES[code] ?? code;
}

// --- The calculated index ----------------------------------------------------
// The stored tpi/jpi column is what the importer wrote. Recomputing here — with
// the same registry, resolved for THIS round — is what lets the page show the
// sub-index inputs behind the number rather than simply asserting the number.
// When the two disagree the registry has moved since import, and the page says
// so rather than quietly showing one of them.

type IndexCalc =
  | { kind: "tpi"; result: TpiResult }
  | { kind: "jpi"; result: JpiResult }
  | { kind: "unavailable"; reason: string };

function computeIndex(isJersey: boolean, gpta: NumMap, roundCode: string | null): IndexCalc {
  if (!roundCode) {
    return { kind: "unavailable", reason: "This row carries no round code, so no formula version can be resolved for it." };
  }
  try {
    if (isJersey) {
      const r = computeJpi(gpta, roundCode);
      return r
        ? { kind: "jpi", result: r }
        : {
            kind: "unavailable",
            reason: "At least one of the ten traits the JPI formula reads is missing from this evaluation. A partial index is a wrong index, so none is computed.",
          };
    }
    const r = computeTpi(gpta, roundCode);
    return r
      ? { kind: "tpi", result: r }
      : {
          kind: "unavailable",
          reason: "At least one trait the TPI formula for this round reads is missing from this evaluation. A partial index is a wrong index, so none is computed.",
        };
  } catch (e) {
    if (e instanceof TpiUnavailable || e instanceof JpiUnavailable) return { kind: "unavailable", reason: e.message };
    throw e;
  }
}

/** Plain-language names for the TPI formula's term keys. */
const TPI_TERM_LABELS: Record<TpiInputKey, string> = {
  PTAP: "Protein (PTA, lb)",
  PTAF: "Fat (PTA, lb)",
  FE: "Feed Efficiency sub-index (derived)",
  PTAT: "Type (PTAT)",
  UDC: "Udder Composite (derived)",
  FLC: "Feet & Legs Composite (derived)",
  PL: "Productive Life",
  HT: "Health Trait sub-index (derived)",
  LIV: "Livability",
  SCS: "Somatic Cell Score",
  FI: "Fertility sub-index (derived)",
  DCE: "Daughter Calving Ease",
  DSB: "Daughter Stillbirth",
  DF: "Daughter Fertility",
};

const JPI_TERM_LABELS: Record<string, string> = {
  PRO: "Protein (PTA, lb)", FAT: "Fat (PTA, lb)", PL: "Productive Life", CCR: "Cow Conception Rate",
  DPR: "Daughter Pregnancy Rate", SCS: "Somatic Cell Score", MAS: "Mastitis resistance",
  UDP: "Udder Depth (scored on distance from an optimum)", FUA: "Fore Udder Attachment (capped)",
  RUH: "Rear Udder Height (capped)",
};

const CONFIDENCE_NOTE: Record<string, string> = {
  verified: "Every layer of this formula was read from the association's own published formula, and the arithmetic reproduces their published lists.",
  inferred: "At least one layer of this formula is inferred — its weights are read from a published source, but the arithmetic has not been checked against a published list for these rounds.",
  contested: "At least one layer of this formula is contested — two readings of the published source disagree on a coefficient. Treat this index as indicative only.",
};

function IndexBreakdown({
  calc, isJersey, stored, storedVersion, storedConfidence, roundCode,
}: {
  calc: IndexCalc;
  isJersey: boolean;
  stored: number | null;
  storedVersion: string | null;
  storedConfidence: string | null;
  roundCode: string | null;
}) {
  const name = isJersey ? "JPI" : "GTPI";
  if (calc.kind === "unavailable") {
    return (
      <div>
        <p className="text-sm text-slate-600">
          {name} cannot be shown with its inputs for the {roundLabel(roundCode)} round.
        </p>
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{calc.reason}</p>
        {stored != null && (
          <p className="mt-2 text-xs text-slate-500">
            A stored value of {stored} sits on this round{storedVersion ? ` (${storedVersion} formula)` : ""}, written
            when the round was imported. It is shown on the Main tab; its inputs cannot be reconstructed here.
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          The formula registry never falls back to the current formula for a round it does not cover — that would be
          wrong by hundreds of points — so it refuses instead.
        </p>
      </div>
    );
  }

  const value = calc.result.value;
  const confidence = calc.result.confidence;
  const mismatch = stored != null && stored !== value;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="flex h-16 w-20 flex-col items-center justify-center rounded-lg bg-accent-600 text-white">
            <span className="text-2xl font-bold leading-none">{value}</span>
            <span className="text-[9px] uppercase tracking-wide">{name} calc.</span>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-800">
              {calc.kind === "tpi" ? calc.result.formula.tpi.label : calc.result.version.label} formula
            </div>
            <Badge tone={confidence === "verified" ? "green" : confidence === "inferred" ? "amber" : "red"}>{confidence}</Badge>
            <div className="mt-1 text-[11px] text-slate-400">
              whole numbers only · accuracy ±3 points · {roundLabel(roundCode)} round
            </div>
          </div>
        </div>
        {mismatch && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            The value stored at import was <strong>{stored}</strong>
            {storedVersion ? ` (${storedVersion})` : ""}; recomputing it now gives <strong>{value}</strong>. The
            formula registry has changed since this round was imported — re-run the index recompute so the stored
            column agrees with the registry.
          </div>
        )}
      </div>

      <p className="mb-3 text-xs text-slate-500">
        {CONFIDENCE_NOTE[confidence] ?? ""}{" "}
        {storedConfidence && storedConfidence !== confidence
          ? `The importer recorded confidence "${storedConfidence}" for the stored value.`
          : ""}
      </p>

      {calc.kind === "tpi" ? (
        <>
          <Table
            head={
              <>
                <th className="th">Term</th>
                <th className="th text-right">Value</th>
                <th className="th text-right">Weight</th>
                <th className="th text-right">Divisor</th>
                <th className="th text-right">Contribution</th>
              </>
            }
          >
            {calc.result.terms.map((t) => (
              <tr key={t.key} className="hover:bg-slate-50">
                <td className="td">
                  <span className="font-medium">{TPI_TERM_LABELS[t.key] ?? t.key}</span>
                  <span className="ml-2 font-mono text-[10px] text-slate-400">{t.key}</span>
                </td>
                <td className="td text-right tabular-nums">{round2(t.value)}</td>
                <td className="td text-right tabular-nums text-slate-500">{t.weight}</td>
                <td className="td text-right tabular-nums text-slate-500">{t.sd}</td>
                <td className={`td text-right font-semibold tabular-nums ${t.contribution > 0 ? "text-emerald-700" : t.contribution < 0 ? "text-red-600" : "text-slate-500"}`}>
                  {round2(t.contribution)}
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-slate-500">
            Each term is <span className="font-mono">weight × (value ÷ divisor)</span>. They sum to{" "}
            <strong>{round2(calc.result.bracket)}</strong>, which is multiplied by{" "}
            <strong>{calc.result.formula.tpi.mult}</strong> and offset by{" "}
            <strong>{calc.result.formula.tpi.constant}</strong> to give {value}. The divisors are the
            formula&rsquo;s own, frozen at adoption — they are not current population standard deviations. A
            negative contribution is not a fault in the bull: SCS, DCE and DSB carry negative weights because their
            favourable direction is down.
          </p>

          <h3 className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Derived sub-indexes and composites</h3>
          <Table head={<><th className="th">Component</th><th className="th text-right">Value</th><th className="th">Formula version</th></>}>
            <tr><td className="td">Feed Efficiency (FE$)</td><td className="td text-right tabular-nums">{round2(calc.result.composites.fe)}</td><td className="td text-xs text-slate-500">{calc.result.formula.fe?.label ?? "not used by this formula"}</td></tr>
            <tr><td className="td">Fertility Index (FI)</td><td className="td text-right tabular-nums">{round2(calc.result.composites.fi)}</td><td className="td text-xs text-slate-500">{calc.result.formula.fi?.label ?? "not used by this formula"}</td></tr>
            <tr><td className="td">Health Trait Index (HT)</td><td className="td text-right tabular-nums">{round2(calc.result.composites.ht)}</td><td className="td text-xs text-slate-500">{calc.result.formula.ht?.label ?? "not used by this formula"}</td></tr>
            <tr><td className="td">Udder Composite (UDC)</td><td className="td text-right tabular-nums">{round2(calc.result.composites.udc)}</td><td className="td text-xs text-slate-500">{calc.result.formula.udc?.label ?? "not used by this formula"}</td></tr>
            <tr><td className="td">Feet &amp; Legs Composite (FLC)</td><td className="td text-right tabular-nums">{round2(calc.result.composites.flc)}</td><td className="td text-xs text-slate-500">{calc.result.formula.flc?.label ?? "not used by this formula"}</td></tr>
            <tr><td className="td">Body Weight Composite (BWC)</td><td className="td text-right tabular-nums">{round2(calc.result.composites.bwc)}</td><td className="td text-xs text-slate-500">{calc.result.formula.bwc.label}</td></tr>
          </Table>
          <p className="mt-2 text-xs text-slate-500">
            None of these six is published by CDCB. Each is computed here from CDCB traits using the Holstein
            Association USA definition in force for this round, and each versions independently of the TPI formula
            itself — in August 2024 the Fertility Index changed while the TPI formula image did not.
          </p>
        </>
      ) : (
        <>
          <Table
            head={
              <>
                <th className="th">Trait</th>
                <th className="th text-right">Published</th>
                <th className="th text-right">Scored</th>
                <th className="th text-right">Weight</th>
                <th className="th text-right">Divisor</th>
                <th className="th text-right">Contribution</th>
              </>
            }
          >
            {calc.result.terms.map((t) => (
              <tr key={t.key} className="hover:bg-slate-50">
                <td className="td">
                  <span className="font-medium">{JPI_TERM_LABELS[t.key] ?? t.key}</span>
                  <span className="ml-2 font-mono text-[10px] text-slate-400">{t.key}</span>
                </td>
                <td className="td text-right tabular-nums">{round2(t.input)}</td>
                <td className="td text-right tabular-nums text-slate-600">{round2(t.scored)}</td>
                <td className="td text-right tabular-nums text-slate-500">{t.weight}</td>
                <td className="td text-right tabular-nums text-slate-500">{t.sd}</td>
                <td className={`td text-right font-semibold tabular-nums ${t.contribution > 0 ? "text-emerald-700" : t.contribution < 0 ? "text-red-600" : "text-slate-500"}`}>
                  {round2(t.contribution)}
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-slate-500">
            &ldquo;Published&rdquo; is the CDCB PTA; &ldquo;scored&rdquo; is what the AJCA formula actually feeds
            into the sum. They differ for three traits on purpose: udder depth is scored on its distance from an
            intermediate optimum, and fore udder and rear udder height are capped, so more is not better past the
            cap. The divisors are AJCA&rsquo;s, frozen at formula adoption — not the current population standard
            deviations printed elsewhere in the Green Book.
          </p>
        </>
      )}
    </div>
  );
}

// --- Trait catalogue --------------------------------------------------------
// CDCB ships trait CODES and nothing else — no labels, no units, no direction.
// This is the display dictionary for them: labels, units and decimals only.
//
// DIRECTION IS NOT DEFINED HERE. It comes from US_SPECIALIST_CATALOG in
// specialists.ts, which is this repository's single reasoned source for which way
// is better and carries an explicit "unknown" for codes whose meaning has not been
// confirmed. Keeping a second direction list on this page produced a real
// disagreement — Stature and Dairy Form were "higher" here and "intermediate"
// there — and the whole point of the intermediate-optimum rule is that a page must
// never quietly call a change good.

interface UsTraitDef {
  label: string;
  group: string;
  /** "$" prefixes, "%" suffixes, anything else is a suffixed unit word. */
  unit?: string;
  decimals: number;
  /** False for traits published on an absolute scale, where a "+" would be wrong. */
  signed: boolean;
}

const MERIT = "Merit indexes", PROD = "Production", FERT = "Fertility";
const HEALTH = "Health and longevity", CALV = "Calving", FEED = "Feed", TYPE = "Type";
const LINEAR = "Type — linear", OTHER = "Other published traits";

const d = (label: string, group: string, decimals: number, opts: Partial<UsTraitDef> = {}): UsTraitDef => ({
  label, group, decimals, signed: true, ...opts,
});

const US_TRAITS: Record<string, UsTraitDef> = {
  NM: d("Net Merit", MERIT, 0, { unit: "$" }),
  CM: d("Cheese Merit", MERIT, 0, { unit: "$" }),
  FM: d("Fluid Merit", MERIT, 0, { unit: "$" }),
  GM: d("Grazing Merit", MERIT, 0, { unit: "$" }),

  MILK: d("Milk", PROD, 0, { unit: "lb" }),
  FAT: d("Fat", PROD, 0, { unit: "lb" }),
  PRO: d("Protein", PROD, 0, { unit: "lb" }),
  FATPCT: d("Fat percent", PROD, 2, { unit: "%" }),
  PROPCT: d("Protein percent", PROD, 2, { unit: "%" }),

  DPR: d("Daughter Pregnancy Rate", FERT, 1, { unit: "%" }),
  HCR: d("Heifer Conception Rate", FERT, 1, { unit: "%" }),
  CCR: d("Cow Conception Rate", FERT, 1, { unit: "%" }),
  EFC: d("Early First Calving", FERT, 1),
  GL: d("Gestation Length", FERT, 1),

  PL: d("Productive Life", HEALTH, 1),
  LIV: d("Cow Livability", HEALTH, 1, { unit: "%" }),
  HLV: d("Heifer Livability", HEALTH, 1, { unit: "%" }),
  // SCS is published on an absolute scale around 3.0, not as a deviation, so it
  // takes no sign — and lower is better (see specialists.ts).
  SCS: d("Somatic Cell Score", HEALTH, 2, { signed: false }),
  MFV: d("Milk Fever resistance", HEALTH, 1, { unit: "%" }),
  DAB: d("Displaced Abomasum resistance", HEALTH, 1, { unit: "%" }),
  KET: d("Ketosis resistance", HEALTH, 1, { unit: "%" }),
  MAS: d("Mastitis resistance", HEALTH, 1, { unit: "%" }),
  MET: d("Metritis resistance", HEALTH, 1, { unit: "%" }),
  RPL: d("Retained Placenta resistance", HEALTH, 1, { unit: "%" }),
  MSPD: d("Milking Speed", HEALTH, 2, { unit: "lb/min" }),

  // Calving traits are published as a percentage of births, absolute and
  // lower-is-better — an unsigned scale where "+7%" would misread as a gain.
  SCE: d("Service Sire Calving Ease", CALV, 1, { unit: "%", signed: false }),
  DCE: d("Daughter Calving Ease", CALV, 1, { unit: "%", signed: false }),
  SSB: d("Service Sire Stillbirth", CALV, 1, { unit: "%", signed: false }),
  DSB: d("Daughter Stillbirth", CALV, 1, { unit: "%", signed: false }),

  FS: d("Feed Saved", FEED, 0, { unit: "lb" }),
  RFI: d("Residual Feed Intake", FEED, 0, { unit: "lb" }),

  PTAT: d("Type (PTAT)", TYPE, 2),

  STA: d("Stature", LINEAR, 2),
  STR: d("Strength", LINEAR, 2),
  BDE: d("Body Depth", LINEAR, 2),
  DFM: d("Dairy Form", LINEAR, 2),
  RPA: d("Rump Angle", LINEAR, 2),
  TRW: d("Thurl Width", LINEAR, 2),
  RLS: d("Rear Legs, side view", LINEAR, 2),
  RLR: d("Rear Legs, rear view", LINEAR, 2),
  FTA: d("Foot Angle", LINEAR, 2),
  FLS: d("Feet and Legs Score", LINEAR, 2),
  FUA: d("Fore Udder Attachment", LINEAR, 2),
  RUH: d("Rear Udder Height", LINEAR, 2),
  RUW: d("Rear Udder Width", LINEAR, 2),
  UCL: d("Udder Cleft", LINEAR, 2),
  UDP: d("Udder Depth", LINEAR, 2),
  FTP: d("Front Teat Placement", LINEAR, 2),
  RTP: d("Rear Teat Placement", LINEAR, 2),
  TLG: d("Teat Length", LINEAR, 2),
};

const GROUP_ORDER = [MERIT, PROD, FERT, HEALTH, CALV, FEED, TYPE, LINEAR, OTHER];

/** The catalogue order within a group, so a group reads the way it was written. */
const CATALOGUE_ORDER = Object.keys(US_TRAITS);

function byCatalogue(x: string, y: string): number {
  const ix = CATALOGUE_ORDER.indexOf(x), iy = CATALOGUE_ORDER.indexOf(y);
  return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || x.localeCompare(y);
}

/** Direction comes from specialists.ts — the repo's reasoned catalogue — and is
 *  "unknown" for anything it does not cover. An unknown direction is never ranked,
 *  highlighted, or described as good or bad. */
const DIRECTIONS = new Map<string, UsSpecialistDirection>(US_SPECIALIST_CATALOG.map((t) => [t.code, t.direction]));
function directionOf(code: string): UsSpecialistDirection {
  return DIRECTIONS.get(code) ?? "unknown";
}

interface TraitRow { code: string; def: UsTraitDef | undefined }

function groupTraits(gpta: NumMap, dgv: NumMap, pa: NumMap) {
  // The union, not just gptaJson: a trait can carry a parent average with no
  // published GPTA yet, and dropping it would hide that the animal has one.
  const codes = [...new Set([...Object.keys(gpta), ...Object.keys(dgv), ...Object.keys(pa)])];
  const byGroup = new Map<string, TraitRow[]>();
  for (const code of codes) {
    const def = US_TRAITS[code];
    const group = def?.group ?? OTHER;
    const arr = byGroup.get(group) ?? [];
    arr.push({ code, def });
    byGroup.set(group, arr);
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((group) => ({
    group,
    rows: (byGroup.get(group) ?? []).sort((x, y) => byCatalogue(x.code, y.code)),
  }));
}

/** The linear type traits, split into the same three sections specialists.ts uses
 *  (udder / feet & legs / body) so the Type tab reads like a type page rather than
 *  one long alphabetical list. */
const LINEAR_SECTIONS: { group: string; codes: string[] }[] = [
  { group: "Overall & udder", codes: ["PTAT", "FUA", "RUH", "RUW", "UCL", "UDP", "FTP", "RTP", "TLG"] },
  { group: "Feet & legs", codes: ["FLS", "FTA", "RLR", "RLS"] },
  { group: "Body", codes: ["STA", "STR", "BDE", "TRW", "RPA", "DFM"] },
];

function groupLinear(gpta: NumMap, dgv: NumMap, pa: NumMap) {
  const has = (c: string) => c in gpta || c in dgv || c in pa;
  return LINEAR_SECTIONS
    .map((s) => ({ group: s.group, rows: s.codes.filter(has).map((code) => ({ code, def: US_TRAITS[code] })) }))
    .filter((s) => s.rows.length > 0);
}

// --- Formatting -------------------------------------------------------------

type NumMap = Record<string, number>;

function parseMap(json: string | null): NumMap {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: NumMap = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function parseStringMap(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (v != null && v !== "") out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

function fmtTrait(def: UsTraitDef | undefined, v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  // An unrecognised code gets two decimals and a sign — the least-assuming
  // rendering of a number whose scale we do not know.
  const decimals = def?.decimals ?? 2;
  const signed = def?.signed ?? true;
  const s = v.toFixed(decimals);
  const withSign = signed && v > 0 ? `+${s}` : s;
  if (def?.unit === "$") return `$${withSign}`;
  if (def?.unit === "%") return `${withSign}%`;
  return def?.unit ? `${withSign} ${def.unit}` : withSign;
}

/** The key-trait block reads the indexed columns, not the JSON — same values,
 *  and it keeps this page agreeing with the lineup's sort order exactly. */
function keyTraitValue(t: UsKeyTrait, r: UsRound): string {
  const v = r[t.column] as number | null;
  if (t.code === "GTPI") return r.tpi == null ? "—" : String(r.tpi);
  return formatUsTrait(t, v);
}

function delta(cur: number | null | undefined, prev: number | null | undefined, decimals: number): string | null {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < 0.005) return "no change";
  return `${diff > 0 ? "+" : ""}${diff.toFixed(decimals)}`;
}

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const round2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/** cdcbRoundLabel wants a classified file; a round code is all we store, so feed
 *  it the one field it reads. */
function roundLabel(roundCode: string | null): string {
  if (!roundCode) return "—";
  return cdcbRoundLabel({ family: null, kind: null, breed: null, roundCode, periodKey: null, date: roundCode }) ?? roundCode;
}

// --- Small presentational pieces --------------------------------------------

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
      <dd className="mt-0.5 text-slate-800">{v}</dd>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5 last:border-0">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-medium text-slate-800">{v}</dd>
    </div>
  );
}

function ParentValue({ id17, link }: { id17: string | null; link: { animalId: string; name: string | null } | null }) {
  if (!id17) return <span className="text-slate-400">not recorded</span>;
  if (!link) return <span className="font-mono text-xs">{id17}</span>;
  return (
    <Link href={`/us/animals/${link.animalId}`} className="link">
      {link.name ?? id17} <span className="font-mono text-[10px] text-slate-400">{id17}</span>
    </Link>
  );
}

function DirectionBadge({ code }: { code: string }) {
  switch (directionOf(code)) {
    case "intermediate":
      return <Badge tone="amber">intermediate optimum</Badge>;
    case "lower":
      return <Badge>lower is better</Badge>;
    case "unknown":
      return <Badge tone="slate">direction not confirmed</Badge>;
    default:
      return null;
  }
}

function TraitTable({
  rows, gpta, rel, dgv, pa,
}: {
  rows: TraitRow[];
  gpta: NumMap; rel: NumMap; dgv: NumMap; pa: NumMap;
}) {
  return (
    <Table
      head={
        <>
          <th className="th">Trait</th>
          <th className="th text-right">GPTA</th>
          <th className="th text-right">Rel.</th>
          <th className="th text-right">DGV</th>
          <th className="th text-right">PA</th>
        </>
      }
    >
      {rows.map((t) => (
        <tr key={t.code} className="hover:bg-slate-50">
          <td className="td">
            <span className="font-medium">{t.def?.label ?? t.code}</span>
            <span className="ml-2 font-mono text-[10px] text-slate-400">{t.code}</span>
            <span className="ml-2 align-middle"><DirectionBadge code={t.code} /></span>
          </td>
          <td className="td text-right font-semibold tabular-nums">{fmtTrait(t.def, gpta[t.code])}</td>
          <td className="td text-right tabular-nums text-slate-500">{rel[t.code] != null ? `${rel[t.code]}%` : "—"}</td>
          <td className="td text-right tabular-nums text-slate-600">{fmtTrait(t.def, dgv[t.code])}</td>
          <td className="td text-right tabular-nums text-slate-600">{fmtTrait(t.def, pa[t.code])}</td>
        </tr>
      ))}
    </Table>
  );
}

function Cell({ value, delta: change, note }: { value: string; delta: string | null; note?: string | null }) {
  return (
    <td className="td text-right tabular-nums">
      <div className="font-semibold">{value}</div>
      {change && (
        <div className={`text-[11px] ${change.startsWith("+") ? "text-emerald-600" : change.startsWith("-") ? "text-red-600" : "text-slate-400"}`}>
          {change}
        </div>
      )}
      {!change && note && <div className="text-[11px] text-slate-400">{note}</div>}
    </td>
  );
}
