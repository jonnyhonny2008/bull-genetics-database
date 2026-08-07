import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, StatCard, Badge, Table, EmptyState } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// The American lineup, in aggregate — the US answer to /analysis.
//
// It is deliberately NOT the same page. Canada's version is built around Rollback
// Resistance, which scores how a bull holds up through Lactanet's ANNUAL April
// re-basing. CDCB re-bases roughly every five years, so there is no annual event
// to score and the metric would be a number computed on a false premise. It is
// absent here on purpose, not pending.
//
// What replaces it is a description of the population itself: who is in it, how
// they split by breed / proven-vs-genomic / AI status, and how GTPI and Net Merit
// are actually distributed. One comparative figure IS offered — round-to-round
// GTPI movement — and only in the cohort-relative form (base 100, 5 points = one
// standard deviation), because raw US round-to-round movement is a fraction of a
// standard deviation and an absolute score of it would not separate anybody. When
// there is not enough data to express it that way, it is omitted rather than
// shipped weak.
//
// Reads UsEvaluation ONLY — never GeneticEvaluation, whose values are EBVs in
// kilograms rather than PTAs in pounds.
// ---------------------------------------------------------------------------

/** Bounds the per-row work on a page load. The lineup is a few thousand bulls. */
const MAX_ROWS = 20000;
/** Below this a cohort mean and SD describe noise, not a population. */
const MIN_COHORT = 30;

export default async function UsAnalysisPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/us/dashboard");

  const breed = (searchParams.breed ?? "").toUpperCase();

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let missingTables = false;
  try {
    data = await load(breed);
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, say so
    // plainly rather than rendering a 500 — this is a setup state, not a fault.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) missingTables = true;
    else throw e;
  }

  if (missingTables || !data) {
    return (
      <div>
        <PageHeader title="Lineup analysis · American" subtitle="CDCB evaluations" />
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      </div>
    );
  }

  const { rounds, breedCounts, rows, ai, movement } = data;
  const total = rows.length;

  // Proven vs genomic. IS_PTA_MILK is CDCB's flag for the PRODUCTION trait group
  // specifically, not a property of the bull — a sire can be daughter-proven for
  // yield and still parent-average for calving traits, so this is labelled as the
  // production answer rather than as "proven".
  const provenN = rows.filter((r) => r.isPtaMilk === true).length;
  const genomicN = rows.filter((r) => r.isPtaMilk === false).length;
  const unknownN = total - provenN - genomicN;

  const tpis = rows.map((r) => r.tpi).filter((v): v is number => v != null);
  const nms = rows.map((r) => r.nmDollar).filter((v): v is number => v != null);

  const breedsPresent = CDCB_BREEDS.filter((b) => breedCounts.some((c) => c.evalBreed === b && c.n > 0));
  const pill = (href: string, label: string, on: boolean) => (
    <Link key={label} href={href} className={`rounded-full border px-3 py-1 text-xs font-medium ${on ? "border-brand-400 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-600 hover:border-brand-300"}`}>{label}</Link>
  );

  return (
    <div>
      <PageHeader
        title="Lineup analysis · American"
        subtitle={`The CDCB population this stud holds — ${fmtNum(total)} bull${total === 1 ? "" : "s"} on their preferred official round${breed ? ` · ${breed} only` : ""}. PTAs in pounds.`}
      />

      {total === 0 ? (
        <EmptyState message="No official CDCB round has been imported yet. Run a CDCB round through the importer and this page fills in automatically." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Bulls in lineup" value={fmtNum(total)} tone="good" hint="preferred official round" />
            <StatCard label="Official rounds on file" value={fmtNum(rounds.length)} hint={rounds.slice(0, 3).map((r) => r.roundCode).join(" · ") || undefined} />
            <StatCard label="Daughter-proven (milk)" value={fmtNum(provenN)} hint={`${fmtNum(genomicN)} genomic · ${fmtNum(unknownN)} unstated`} />
            <StatCard label="Active AI" value={ai ? fmtNum(ai.A) : "—"} tone="accent" hint={ai ? `round ${ai.roundCode} · ${fmtNum(ai.G)} marketed young` : "no AI-status file imported"} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {pill("/us/analysis", "All breeds", !breed)}
            {breedsPresent.map((b) => pill(`/us/analysis?breed=${b}`, b, breed === b))}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="By breed">
              <Table head={<>
                <th className="th">Breed</th>
                <th className="th text-right">Bulls</th>
                <th className="th text-right" title="Daughter-proven for the production traits">Proven</th>
                <th className="th text-right">Avg NM$</th>
                <th className="th text-right">Avg GTPI</th>
              </>}>
                {breedCounts.map((b) => (
                  <tr key={b.evalBreed ?? "—"}>
                    <td className="td font-medium">{b.evalBreed ?? "—"}</td>
                    <td className="td text-right tabular-nums">{fmtNum(b.n)}</td>
                    <td className="td text-right tabular-nums text-slate-500">{fmtNum(b.proven)}</td>
                    <td className="td text-right tabular-nums">{b.avgNm == null ? "—" : `$${Math.round(b.avgNm)}`}</td>
                    <td className="td text-right tabular-nums">{b.avgTpi == null ? "—" : Math.round(b.avgTpi)}</td>
                  </tr>
                ))}
              </Table>
              <p className="mt-2 text-[11px] text-slate-500">
                Breed is CDCB&rsquo;s EVAL_BREED — the breed the animal was <em>evaluated</em> in, not the registry
                prefix on its id. GTPI is only computed for Holsteins, so the other breeds show no average.
              </p>
            </Card>

            <Card title="AI status (CDCB status file)">
              {!ai ? (
                <EmptyState message="No AI-status file has been imported for any round yet, so nothing here can say which bulls are actually being marketed." />
              ) : (
                <>
                  <div className="space-y-2 text-sm">
                    <Bar label="A — active AI" value={ai.A} total={ai.total} tone="bg-brand-500" />
                    <Bar label="G — genomic young bull, marketed" value={ai.G} total={ai.total} tone="bg-purple-500" />
                    <Bar label="F — foreign" value={ai.F} total={ai.total} tone="bg-amber-500" />
                  </div>
                  <p className="mt-3 text-[11px] text-slate-500">
                    Round {ai.roundCode}, counted over the bulls in this lineup. <strong>Active is not the same
                    thing as carrying a NAAB code</strong> — on this side it is whatever the status file says, which
                    is the only statement CDCB makes about whether a bull is actually being sold.
                    {ai.unmatchedInFile > 0 && <> {fmtNum(ai.unmatchedInFile)} entries in that file match no animal held here and are not counted.</>}
                  </p>
                </>
              )}
            </Card>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title={`GTPI distribution (calculated) — ${fmtNum(tpis.length)} bull${tpis.length === 1 ? "" : "s"}`}>
              {tpis.length === 0 ? (
                <EmptyState message="GTPI is computed for Holsteins only. No Holstein round is loaded for this filter." />
              ) : (
                <Histogram values={tpis} width={100} tone="bg-brand-500" fmtBand={(lo) => `${lo}–${lo + 99}`} />
              )}
              <p className="mt-3 text-[11px] text-slate-500">
                <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
                Association USA formula in force for each round. It is not an official Holstein Association USA
                publication and is typically within ±3 points, so it is shown as a whole number throughout. TPI is
                a registered trademark of Holstein Association USA.
              </p>
            </Card>

            <Card title={`Net Merit distribution — ${fmtNum(nms.length)} bull${nms.length === 1 ? "" : "s"}`}>
              {nms.length === 0 ? (
                <EmptyState message="No Net Merit values in this filter." />
              ) : (
                <Histogram values={nms} width={200} tone="bg-accent-500" fmtBand={(lo) => `$${lo} – $${lo + 199}`} />
              )}
              <p className="mt-3 text-[11px] text-slate-500">
                NM$ as CDCB publishes it. Unlike GTPI this is an official figure and is not recomputed here.
              </p>
            </Card>
          </div>

          <Card title="Round-to-round GTPI movement" className="mt-4">
            {movement ? (
              <>
                <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatCard label="Bulls in both rounds" value={fmtNum(movement.n)} hint={`${movement.from} → ${movement.to}`} />
                  <StatCard label="Cohort mean move" value={`${movement.mean > 0 ? "+" : ""}${Math.round(movement.mean)}`} hint="GTPI points" />
                  <StatCard label="Cohort SD" value={Math.round(movement.sd).toString()} hint="GTPI points" />
                  <StatCard label="Base" value="100" tone="good" hint="5 points = 1 SD" />
                </div>
                <Table head={<>
                  <th className="th">Bull</th>
                  <th className="th text-right">{movement.from}</th>
                  <th className="th text-right">{movement.to}</th>
                  <th className="th text-right">Move</th>
                  <th className="th text-right" title="100 = the cohort average move between these two rounds; every 5 points is one standard deviation">Vs cohort</th>
                </>}>
                  {movement.top.map((m) => (
                    <tr key={m.usAnimalId}>
                      <td className="td"><Link href={`/us/animals/${m.usAnimalId}`} className="link font-medium">{m.name}</Link></td>
                      <td className="td text-right tabular-nums text-slate-500">{m.before}</td>
                      <td className="td text-right tabular-nums text-slate-500">{m.after}</td>
                      <td className={`td text-right tabular-nums ${m.delta > 0 ? "text-brand-700" : m.delta < 0 ? "text-red-600" : "text-slate-500"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                      <td className={`td text-right font-semibold tabular-nums ${m.standing >= 105 ? "text-brand-700" : m.standing < 95 ? "text-red-600" : "text-slate-700"}`}>{m.standing}</td>
                    </tr>
                  ))}
                </Table>
                <p className="mt-3 text-[11px] text-slate-500">
                  The <strong>Vs cohort</strong> column is a deviation from the average move of the {fmtNum(movement.n)} bulls
                  that appear in both rounds: 100 is that average and every 5 points is one standard deviation. It is
                  expressed that way on purpose. American round-to-round movement is small in absolute terms, so an
                  absolute &ldquo;retention out of 100&rdquo; score would put nearly every bull in the same band and
                  separate nobody. This is <strong>not</strong> Rollback Resistance and must not be read as it — see below.
                </p>
              </>
            ) : (
              <EmptyState message={
                rounds.length < 2
                  ? "Only one official CDCB round is on file. A second round is needed before any movement can be measured — and it will only be shown relative to the cohort, never as an absolute score."
                  : `Fewer than ${MIN_COHORT} bulls carry a GTPI in both of the two most recent official rounds. A cohort that small would give a mean and a standard deviation that describe noise, so no movement figure is shown at all rather than a weak one.`
              } />
            )}
          </Card>

          <Card title="What this page does not have, and why" className="mt-4">
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
              <li>
                <strong>No Rollback Resistance.</strong> That score measures how a bull holds up through Lactanet&rsquo;s
                re-basing of the genetic base every April. CDCB re-bases roughly every five years, so there is no annual
                event to score; computing the same number here would put a real-looking figure on a false premise.
              </li>
              <li>
                <strong>No interim comparison.</strong> CDCB ships one file per round. There is no official/interim pair
                for an interim report to compare, so that report does not exist on this side.
              </li>
              <li>
                <strong>Official rounds only.</strong> Monthly (provisional) and weekly (unofficial) adds are stored but
                are never counted as a round or ranked alongside one.
              </li>
              <li>
                <strong>Rump Angle is never ranked anywhere</strong> in this system. It has an intermediate optimum, so
                a &ldquo;top rump angle&rdquo; list would be meaningless. See <Link href="/us/compare" className="link">Compare bulls</Link>.
              </li>
            </ul>
          </Card>

          {total >= MAX_ROWS && (
            <p className="mt-3 text-[11px] text-amber-600">Showing the first {fmtNum(MAX_ROWS)} bulls — the lineup is larger than this page samples.</p>
          )}
        </>
      )}
    </div>
  );
}

// --- data --------------------------------------------------------------------

async function load(breed: string) {
  // Only official rows are authoritative. isPreferred is already only ever set on
  // an official row, but the runKind filter is stated anyway so a future change to
  // the preferred recompute cannot quietly admit a provisional monthly here.
  const officialPreferred: Prisma.UsEvaluationWhereInput = {
    isPreferred: true, runKind: "official", approvalStatus: "approved",
  };
  const lineupWhere: Prisma.UsEvaluationWhereInput = {
    ...officialPreferred, ...(breed ? { evalBreed: breed } : {}),
  };

  const [roundGroups, allBreedRows, rows] = await Promise.all([
    prisma.usEvaluation.groupBy({
      by: ["roundCode"],
      where: { runKind: "official", approvalStatus: "approved", roundCode: { not: null } },
      _count: { _all: true },
    }),
    // Breed table covers every breed regardless of the pill filter, so switching
    // filters never hides a breed from the roll-up above it.
    prisma.usEvaluation.findMany({
      where: officialPreferred,
      take: MAX_ROWS,
      select: { evalBreed: true, isPtaMilk: true, tpi: true, nmDollar: true },
    }),
    prisma.usEvaluation.findMany({
      where: lineupWhere,
      take: MAX_ROWS,
      select: { isPtaMilk: true, tpi: true, nmDollar: true },
    }),
  ]);

  const rounds = roundGroups
    .map((g) => ({ roundCode: g.roundCode as string, n: g._count._all }))
    .sort((a, b) => b.roundCode.localeCompare(a.roundCode));

  // Per-breed roll-up. Averages skip nulls rather than treating a blank as zero —
  // CDCB leaves a trait empty when it has no evaluation for it, which is a
  // different statement from "zero".
  const breedAgg = new Map<string, { n: number; proven: number; tpiSum: number; tpiN: number; nmSum: number; nmN: number }>();
  for (const r of allBreedRows) {
    const k = r.evalBreed ?? "—";
    const g = breedAgg.get(k) ?? { n: 0, proven: 0, tpiSum: 0, tpiN: 0, nmSum: 0, nmN: 0 };
    g.n++;
    if (r.isPtaMilk === true) g.proven++;
    if (r.tpi != null) { g.tpiSum += r.tpi; g.tpiN++; }
    if (r.nmDollar != null) { g.nmSum += r.nmDollar; g.nmN++; }
    breedAgg.set(k, g);
  }
  const breedCounts = [...breedAgg.entries()]
    .map(([evalBreed, g]) => ({
      evalBreed,
      n: g.n,
      proven: g.proven,
      avgTpi: g.tpiN ? g.tpiSum / g.tpiN : null,
      avgNm: g.nmN ? g.nmSum / g.nmN : null,
    }))
    .sort((a, b) => b.n - a.n);

  const currentRound = rounds[0]?.roundCode ?? null;
  const ai = currentRound ? await loadAiStatus(currentRound, lineupWhere) : null;
  const movement = rounds.length >= 2 ? await loadMovement(rounds[1].roundCode, rounds[0].roundCode, breed) : null;

  return { rounds, breedCounts, rows, ai, movement };
}

/**
 * AI status for the current round, counted over THIS lineup.
 *
 * The status file is round-scoped and about 5% of its entries match no animal we
 * hold, so the counts are joined through the animal to the lineup rather than
 * taken from the file wholesale — otherwise the totals would describe CDCB's
 * population, not this stud's.
 */
async function loadAiStatus(roundCode: string, lineupWhere: Prisma.UsEvaluationWhereInput) {
  const inLineup: Prisma.UsAiStatusWhereInput = {
    roundCode,
    animal: { is: { usEvaluations: { some: lineupWhere } } },
  };
  const [groups, unmatched] = await Promise.all([
    prisma.usAiStatus.groupBy({ by: ["code"], where: inLineup, _count: { _all: true } }),
    prisma.usAiStatus.count({ where: { roundCode, animalId: null } }),
  ]);
  const of = (code: string) => groups.find((g) => g.code === code)?._count._all ?? 0;
  const total = groups.reduce((s, g) => s + g._count._all, 0);
  if (total === 0 && unmatched === 0) return null;
  return { roundCode, A: of("A"), G: of("G"), F: of("F"), total, unmatchedInFile: unmatched };
}

/**
 * GTPI movement between the two most recent official rounds, expressed only as a
 * deviation from the cohort's own average move.
 *
 * The cohort is the bulls carrying a GTPI in BOTH rounds — the only bulls for whom
 * a move is defined. Bulls appearing for the first time in the newer round have no
 * move and are not silently scored as zero.
 */
async function loadMovement(from: string, to: string, breed: string) {
  const rows = await prisma.usEvaluation.findMany({
    where: {
      runKind: "official", approvalStatus: "approved",
      roundCode: { in: [from, to] },
      tpi: { not: null },
      ...(breed ? { evalBreed: breed } : {}),
    },
    take: MAX_ROWS,
    select: { usAnimalId: true, id17: true, roundCode: true, tpi: true, usAnimal: { select: { name: true, id17: true } } },
  });

  const before = new Map<string, number>(), after = new Map<string, number>();
  const names = new Map<string, string>();
  for (const r of rows) {
    if (r.tpi == null) continue;
    names.set(r.usAnimalId, (r.usAnimal.name ?? r.usAnimal.id17));
    (r.roundCode === from ? before : after).set(r.usAnimalId, r.tpi);
  }

  const pairs: { usAnimalId: string; name: string; before: number; after: number; delta: number }[] = [];
  for (const [animalId, b] of before) {
    const a = after.get(animalId);
    if (a == null) continue;
    pairs.push({ usAnimalId: animalId, name: names.get(animalId) ?? animalId, before: b, after: a, delta: a - b });
  }
  if (pairs.length < MIN_COHORT) return null;

  const mean = pairs.reduce((s, p) => s + p.delta, 0) / pairs.length;
  const variance = pairs.reduce((s, p) => s + (p.delta - mean) ** 2, 0) / pairs.length;
  const sd = Math.sqrt(variance);
  // A zero SD means every bull moved identically — there is nothing to rate.
  if (!(sd > 0)) return null;

  const scored = pairs
    .map((p) => ({ ...p, standing: Math.round(100 + 5 * ((p.delta - mean) / sd)) }))
    .sort((x, y) => y.standing - x.standing);

  return { from, to, n: pairs.length, mean, sd, top: scored.slice(0, 15) };
}

// --- presentation ------------------------------------------------------------

function Bar({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs"><span>{label}</span><span className="text-slate-500">{fmtNum(value)} ({pct}%)</span></div>
      <div className="h-2 w-full rounded-full bg-slate-100"><div className={`h-2 rounded-full ${tone}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/** Fixed-width bands over the values actually present, highest band first — the
 *  top of a sire list is what people read down from. */
function Histogram({
  values, width, tone, fmtBand,
}: {
  values: number[]; width: number; tone: string; fmtBand: (lo: number) => string;
}) {
  const counts = new Map<number, number>();
  for (const v of values) {
    const lo = Math.floor(v / width) * width;
    counts.set(lo, (counts.get(lo) ?? 0) + 1);
  }
  const los = [...counts.keys()].sort((a, b) => b - a);
  const peak = Math.max(...counts.values());
  return (
    <div className="space-y-1.5">
      {los.map((lo) => {
        const n = counts.get(lo) ?? 0;
        return (
          <div key={lo} className="grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-2 text-xs">
            <span className="tabular-nums text-slate-600">{fmtBand(lo)}</span>
            <span className="h-2.5 w-full rounded-full bg-slate-100">
              <span className={`block h-2.5 rounded-full ${tone}`} style={{ width: `${peak ? Math.max(2, Math.round((n / peak) * 100)) : 0}%` }} />
            </span>
            <span className="text-right tabular-nums text-slate-500">{fmtNum(n)}</span>
          </div>
        );
      })}
      <div className="pt-1 text-[11px] text-slate-400">
        Bands of {fmtNum(width)}. <Badge>{fmtNum(values.length)} rated</Badge>
      </div>
    </div>
  );
}
