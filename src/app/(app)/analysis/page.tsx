import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { PageHeader, Card, Table, Badge, EmptyState, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { computeRollback, baselineOf, relativeRating, ratingVerdict, ROLLBACK_TRAIT_LABELS, type RollbackResult } from "@/lib/rollback";
import { attachTraits, traitDefMap } from "@/lib/eval-traits";
import { LineChart, CompareBars, type LineSeries } from "@/components/TrendCharts";
import { SireRolePills, SireRoleField, SireSortField, SireClassBadges } from "@/components/SireFilters";
import { sireRoleWhere, resolveSort } from "@/lib/sire-class";
import { sireRoleCounts } from "@/lib/sire-rank";

export const dynamic = "force-dynamic";

const MAX_BULLS = 1000; // cap the per-bull computation for a page load
const CHART_TRAITS: { code: string; col: string; label: string }[] = [
  { code: "LPI", col: "lpi", label: "LPI" }, { code: "PRO$", col: "proDollar", label: "Pro$" },
  { code: "CONF", col: "conf", label: "Conformation" }, { code: "MILK", col: "milk", label: "Milk" },
  { code: "FAT", col: "fat", label: "Fat" }, { code: "PROT", col: "prot", label: "Protein" },
  { code: "MAMM", col: "mamm", label: "Mammary" }, { code: "FL", col: "fl", label: "Feet & Legs" }, { code: "DS", col: "ds", label: "Dairy Strength" },
];

export default async function AnalysisPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const sp = searchParams;
  const view = sp.view === "charts" ? "charts" : "rankings";
  const bullId = sp.bull || null;
  const chartTrait = CHART_TRAITS.find((t) => t.code === (sp.trait ?? "LPI").toUpperCase()) ?? CHART_TRAITS[0];
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const sortDef = resolveSort(sp.sort);

  // Which sires this page covers.
  //
  // Inactive bulls are the ones whose latest proof predates the most recent
  // round on file — they no longer say much about the current lineup, but they
  // do drag the average a bull is measured against. So the population defaults
  // to active sires and `includeInactive=1` widens it back out.
  const includeInactive = sp.includeInactive === "1";
  const roleWhere = sireRoleWhere(sp.role) as Prisma.AnimalWhereInput | null;
  const animalAND: Prisma.AnimalWhereInput[] = [{ archived: false }];
  if (roleWhere) animalAND.push(roleWhere);
  // When the role filter already pins the active/inactive axis, it wins over the toggle.
  if (!includeInactive && sp.role !== "inactive") animalAND.push({ proofStatus: "active" });
  const animalWhere: Prisma.AnimalWhereInput = { AND: animalAND };

  // Both scores are materialised on Animal by prisma/compute-rollback.ts, so this
  // page reads columns instead of re-deriving them.
  //
  // It used to load every evaluation for up to 1000 bulls — ~8,655 rows — and run
  // computeRollback() on each, on EVERY request. That was slow enough that two
  // concurrent renders could blow up inside React ("Cannot read properties of
  // null (reading 'useContext')"). One indexed query over ~300 animal rows
  // replaces all of it.
  //
  // Reading the column also keeps the scale honest: Rollback Resistance is rated
  // against the cohort of sires (active AND inactive) with the same number of
  // Aprils. Recomputing it from whatever the page filters currently select would
  // silently change what 100 means every time a filter moved.
  const scoredWhere: Prisma.AnimalWhereInput = { AND: [...animalAND, { proofPerformance: { not: null } }] };
  const [totalRounds, totalAnimals, roleCounts, lineup] = await Promise.all([
    prisma.geneticEvaluation.count({ where: { animal: animalWhere } }),
    prisma.animal.count({ where: animalWhere }),
    // Role pill counts: the role IS the axis here, so they ignore the role filter
    // and the inactive toggle and always count the whole non-archived herd.
    sireRoleCounts({ archived: false }),
    prisma.animal.findMany({
      where: scoredWhere,
      take: MAX_BULLS,
      orderBy: { rollbackResistance: "desc" },
      select: {
        id: true, primaryName: true, birthDate: true, proofRoundCount: true,
        proofPerformance: true, proofSteps: true,
        rollbackResistance: true, rollbackRaw: true, rollbackSteps: true, rollbackCohortN: true,
        evaluations: { where: { isPreferred: true }, take: 1, select: { lpi: true, conf: true } },
      },
    }),
  ]);

  const scored = lineup.map((a) => ({
    a,
    resistance: a.rollbackResistance,
    rv: a.rollbackResistance == null ? null : ratingVerdict(a.rollbackResistance),
  }));
  // Shown only to describe the scale in the explainer card.
  const baseline = baselineOf(lineup.map((a) => a.rollbackRaw).filter((v): v is number => v != null));

  // Aggregates.
  const n = scored.length;
  const rated = scored.filter((x) => x.resistance != null);
  const avgPerf = n ? Math.round((scored.reduce((s, x) => s + (x.a.proofPerformance ?? 0), 0) / n) * 10) / 10 : null;
  // Distribution is expressed in Rollback Resistance bands, since the raw
  // retention scores all sit within a point or two of each other.
  const held = rated.filter((x) => (x.resistance as number) >= 105).length;
  const minor = rated.filter((x) => (x.resistance as number) >= 95 && (x.resistance as number) < 105).length;
  const significant = rated.filter((x) => (x.resistance as number) < 95).length;

  // Per-trait retention is the one figure with no materialised column, because it
  // is a breakdown rather than a single number. It needs real trait series, so it
  // runs over a bounded SAMPLE of the deepest-history bulls rather than the whole
  // lineup — and the card says so rather than implying full coverage.
  const TRAIT_SAMPLE = 40;
  const traitRows: { code: string; perf: number; rb: number | null; worst: number }[] = [];
  let traitSampleN = 0;
  if (view === "rankings" && n > 0) {
    const sampleIds = [...lineup]
      .sort((a, b) => (b.rollbackSteps ?? 0) - (a.rollbackSteps ?? 0) || b.proofRoundCount - a.proofRoundCount)
      .slice(0, TRAIT_SAMPLE)
      .map((a) => a.id);
    const [sampleAnimals, defMap] = await Promise.all([
      prisma.animal.findMany({
        where: { id: { in: sampleIds } },
        select: { id: true, evaluations: { orderBy: { evaluationDate: "asc" } } },
      }),
      traitDefMap(),
    ]);
    const agg = new Map<string, { perf: number; perfN: number; rb: number; rbN: number; worst: number }>();
    for (const a of sampleAnimals) {
      const r = computeRollback(
        attachTraits(a.evaluations, defMap).map((e) => ({
          evaluationDate: e.evaluationDate, proofRun: e.proofRun,
          reliabilityOverall: e.reliabilityOverall, traitValues: e.traitValues,
        })),
      );
      if (!r.hasHistory) continue;
      traitSampleN++;
      for (const [code, t] of Object.entries(r.traits)) {
        const g = agg.get(code) ?? { perf: 0, perfN: 0, rb: 0, rbN: 0, worst: 100 };
        g.perf += t.stepResistance; g.perfN += 1; g.worst = Math.min(g.worst, t.worstStep);
        if (t.rollbackResistance != null) { g.rb += t.rollbackResistance; g.rbN += 1; }
        agg.set(code, g);
      }
    }
    traitRows.push(...[...agg.entries()]
      .map(([code, g]) => ({
        code,
        perf: Math.round((g.perf / g.perfN) * 10) / 10,
        rb: g.rbN ? Math.round((g.rb / g.rbN) * 10) / 10 : null,
        worst: Math.round(g.worst),
      }))
      .sort((a, b) => (a.rb ?? a.perf) - (b.rb ?? b.perf)));
  }

  // Leaderboards rank on Rollback Resistance — the comparative measure.
  const bySorted = [...rated].sort((a, b) => (b.resistance as number) - (a.resistance as number));
  const bestHolders = bySorted.slice(0, 15);
  const biggestRollback = [...bySorted].reverse().slice(0, 15);

  // --- Charts view data ---
  // The average a bull is compared against, over the same population the rest
  // of the page covers (active sires unless the toggle widens it).
  const lineupAgg = await prisma.geneticEvaluation.aggregate({
    where: { isPreferred: true, animal: animalWhere },
    _avg: { lpi: true, proDollar: true, conf: true, milk: true, fat: true, prot: true, mamm: true, fl: true, ds: true },
    _count: { _all: true },
  });
  const lineupAvg = lineupAgg._avg as Record<string, number | null>;
  const lineupN = lineupAgg._count._all;

  const pickerBulls = lineup.map((a) => ({
    id: a.id, name: a.primaryName,
    lpi: a.evaluations[0]?.lpi ?? null, conf: a.evaluations[0]?.conf ?? null,
    born: a.birthDate ? a.birthDate.getTime() : null,
  }));
  // Nulls always sink to the bottom regardless of direction, so an unproofed
  // trait never wins a "highest LPI" sort.
  const cmpNum = (a: number | null, b: number | null) =>
    a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : dir === "desc" ? b - a : a - b;
  switch (sortDef?.code) {
    case "lpi": pickerBulls.sort((a, b) => cmpNum(a.lpi, b.lpi)); break;
    case "conf": pickerBulls.sort((a, b) => cmpNum(a.conf, b.conf)); break;
    case "birth": pickerBulls.sort((a, b) => cmpNum(a.born, b.born)); break;
    default:
      pickerBulls.sort((a, b) => a.name.localeCompare(b.name));
      if (sortDef?.code === "name" && dir === "desc") pickerBulls.reverse();
  }

  // Bull picking: a type-ahead box backed by a <datalist> beats a 287-option
  // <select> you have to scroll. `bullName` is what the box submits; `bull` (an
  // id) still works so existing links and bookmarks keep resolving.
  const typed = (sp.bullName ?? "").trim();
  const byTypedName = typed
    ? (pickerBulls.find((b) => b.name.toLowerCase() === typed.toLowerCase())
      ?? pickerBulls.find((b) => b.name.toLowerCase().includes(typed.toLowerCase())))
    : null;
  // Only complain when something was typed and nothing matched at all.
  const bullNotFound = typed.length > 0 && !byTypedName;

  // Only the CHARTS view needs a bull's full round history, and only for the one
  // bull on screen — a single query, not 287 of them.
  const selId = byTypedName?.id ?? (bullId && pickerBulls.some((b) => b.id === bullId) ? bullId : null) ?? pickerBulls[0]?.id ?? null;
  const selBull = view === "charts" && selId
    ? await prisma.animal.findUnique({
        where: { id: selId },
        include: { evaluations: { orderBy: { evaluationDate: "asc" } } },
      })
    : null;

  type EvalRow = NonNullable<typeof selBull>["evaluations"][number];
  const col = chartTrait.col as keyof EvalRow;
  const trendSeries: LineSeries[] = selBull ? [{
    label: chartTrait.label, color: "#2f6551",
    points: selBull.evaluations.map((e) => ({ x: e.proofRun ?? e.evaluationDate.toISOString().slice(0, 7), y: (e[col] as number | null) ?? null })),
  }] : [];
  const selPref = selBull ? (selBull.evaluations.find((e) => e.isPreferred) ?? selBull.evaluations[selBull.evaluations.length - 1]) : null;
  const compareRows = selPref ? CHART_TRAITS.map((t) => ({
    label: t.label,
    a: (selPref[t.col as keyof typeof selPref] as number | null) ?? null,
    b: lineupAvg[t.col] != null ? Math.round(lineupAvg[t.col] as number) : null,
  })) : [];

  // Tab links keep every filter, only swapping the view.
  const tabHref = (v: "rankings" | "charts") => {
    const params = new URLSearchParams();
    for (const [k, val] of Object.entries(sp)) if (val && k !== "view") params.set(k, val);
    if (v === "charts") params.set("view", "charts");
    const qs = params.toString();
    return qs ? `/analysis?${qs}` : "/analysis";
  };
  const popLabel = sp.role
    ? `${sp.role} sires`
    : includeInactive ? "all sires (active + inactive)" : "active sires only";

  return (
    <div>
      <PageHeader
        title="Proof Trends · Rollback Resistance"
        subtitle={`How bulls hold their index profile across proof rounds — calculated automatically from imported rounds. Showing ${popLabel}.`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Bulls with ≥2 rounds" value={fmtNum(n)} tone={n ? "good" : "default"} />
        <StatCard label="Avg. Proof Performance" value={avgPerf != null ? `${avgPerf}` : "—"} />
        <StatCard label="Rollback Resistance base" value="100" tone="good" />
        <StatCard label="Rated on April rounds" value={fmtNum(rated.length)} />
      </div>

      <div className="mt-4">
        <SireRolePills basePath="/analysis" sp={sp} counts={roleCounts} />
      </div>

      <div className="mt-1 flex gap-2 text-sm">
        <TabLink href={tabHref("rankings")} active={view === "rankings"} label="Rankings" />
        <TabLink href={tabHref("charts")} active={view === "charts"} label="Charts & comparison" />
      </div>

      {/* Population + sort, shared by both tabs. The chart form below carries
          these forward as hidden fields so neither form clobbers the other. */}
      <form method="get" className="card card-pad mt-3 flex flex-wrap items-end gap-3">
        {view === "charts" && <input type="hidden" name="view" value="charts" />}
        {bullId && <input type="hidden" name="bull" value={bullId} />}
        {typed && <input type="hidden" name="bullName" value={typed} />}
        <input type="hidden" name="trait" value={chartTrait.code} />
        <SireRoleField value={sp.role} />
        <SireSortField sort={sp.sort} dir={sp.dir} />
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Inactive sires no longer appear in the most recent round, so they are left out by default.">
          <input type="checkbox" name="includeInactive" value="1" defaultChecked={includeInactive} />
          Include inactive sires
        </label>
        <button type="submit" className="btn-primary">Apply</button>
        <a href={view === "charts" ? "/analysis?view=charts" : "/analysis"} className="btn-secondary">Reset</a>
      </form>

      {view === "charts" && (
        <div className="mt-4 space-y-4">
          {pickerBulls.length === 0 ? (
            <Card title="Charts">
              <EmptyState message={
                sp.role || !includeInactive
                  ? `No ${popLabel} have two or more proof rounds. Widen the filter above — or tick "Include inactive sires".`
                  : "Charts appear once bulls have two or more proof rounds imported."
              } />
            </Card>
          ) : (
            <>
              <Card title={`Lineup averages — ${popLabel} (${fmtNum(lineupN)} preferred proofs)`}>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3 lg:grid-cols-5">
                  {CHART_TRAITS.map((t) => (
                    <div key={t.code} className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">{t.label}</span>
                      <span className="font-semibold tabular-nums">{lineupAvg[t.col] != null ? Math.round(lineupAvg[t.col] as number) : "—"}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] text-slate-500">
                  {includeInactive
                    ? "Including inactive sires — bulls whose latest proof predates the most recent round on file."
                    : "Inactive sires are excluded, so the average reflects the sires actually in recent proofs. Use the toggle below to include them."}
                </p>
              </Card>
              <Card title="Bull trend & comparison">
                <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="view" value="charts" />
                  <div>
                    <label className="label" htmlFor="bull-search">Bull ({fmtNum(pickerBulls.length)})</label>
                    <input
                      id="bull-search" name="bullName" list="bull-options" autoComplete="off"
                      defaultValue={typed || selBull?.primaryName || ""}
                      placeholder="Start typing a name…"
                      className="input min-w-[260px]"
                    />
                    {/* Native type-ahead: no client JS, and the browser filters
                        all 287 names as you type. */}
                    <datalist id="bull-options">
                      {pickerBulls.map((b) => <option key={b.id} value={b.name} />)}
                    </datalist>
                  </div>
                  <div>
                    <label className="label">Trait</label>
                    <select name="trait" defaultValue={chartTrait.code} className="input">
                      {CHART_TRAITS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                    </select>
                  </div>
                  {sp.role && <input type="hidden" name="role" value={sp.role} />}
                  {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
                  {sp.dir && <input type="hidden" name="dir" value={sp.dir} />}
                  {includeInactive && <input type="hidden" name="includeInactive" value="1" />}
                  <button type="submit" className="btn-primary">Show</button>
                </form>
                {bullNotFound && (
                  <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    No bull matching &ldquo;{typed}&rdquo; in the current filter. Showing {selBull?.primaryName ?? "nothing"} instead —
                    clear the box, or widen the sire role / inactive filters above.
                  </p>
                )}
                {selBull && (
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-700">
                        <span>{selBull.primaryName} — {chartTrait.label} over proof rounds</span>
                        <SireClassBadges
                          sireType={selBull.sireType} proofStatus={selBull.proofStatus}
                          rollbackCount={selBull.rollbackCount} proofRoundCount={selBull.proofRoundCount}
                          activityCode={selBull.latestActivityCode}
                        />
                      </div>
                      <LineChart series={trendSeries} yLabel={chartTrait.label} />
                    </div>
                    <div>
                      <div className="mb-2 text-sm font-semibold text-slate-700">{selBull.primaryName} vs lineup average (latest proof)</div>
                      <CompareBars rows={compareRows} aLabel={selBull.primaryName} bLabel={includeInactive ? "Lineup avg (all)" : "Lineup avg (active)"} />
                    </div>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      )}

      {view === "rankings" && (n === 0 ? (
        <Card title="No multi-round history yet" className="mt-4">
          <EmptyState message="Rollback resistance needs at least two proof rounds for the same bull.">
            <div className="mt-2 max-w-xl text-left text-sm text-slate-600">
              You&apos;ve imported <strong>one</strong> round so far ({fmtNum(totalAnimals)} bulls). Import another round&apos;s Lactanet file (an earlier or later run) via{" "}
              <Link href="/import-proofs" className="link">Proof Import</Link> — the bulls match by registration number, each gets that round&apos;s evaluation added, and this page fills in automatically. Nothing is estimated; it&apos;s computed from the real rounds on file.
            </div>
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card title="The two scores, and what each one measures" className="mt-4">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-slate-800">Proof Performance</span>
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">out of 100</span>
                </div>
                <p className="text-sm leading-relaxed text-slate-600">
                  <strong>Every proof round counts.</strong> For each consecutive pair of rounds, how much of each
                  trait the bull carried into the next one — holding or gaining scores 100.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  Averaged across all {fmtNum(totalRounds)} rounds on file, then weighted across traits. A long
                  career is not penalised: the only question is whether he held from one round to the next.
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-slate-800">Rollback Resistance</span>
                  <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-700">base 100</span>
                </div>
                <p className="text-sm leading-relaxed text-slate-600">
                  <strong>April rounds only.</strong> Lactanet re-bases the genetic base every April — that is the
                  round where numbers move for reasons other than new data.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  Each bull is compared with the <strong>cohort that has been through the same number of Aprils</strong>,
                  including sires that have since gone inactive. What a bull did at his third base change is the right
                  yardstick for another bull facing his third.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  100 is that cohort&apos;s average and every 5 points is one standard deviation.
                  {baseline.sd > 0 && <> Across the sires shown, raw April retention averages {Math.round(baseline.mean * 10) / 10}% (SD {Math.round(baseline.sd * 100) / 100}).</>}
                </p>
              </div>
            </div>
            {n > rated.length && (
              <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-amber-700">
                {fmtNum(n - rated.length)} of the {fmtNum(n)} bulls shown have not been through an April base change
                yet, so they have a Proof Performance score but no Rollback Resistance.
              </p>
            )}
          </Card>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Rollback Resistance distribution">
              <div className="space-y-2 text-sm">
                <DistRow label="Resists rollback (105+)" value={held} total={rated.length} tone="bg-brand-500" />
                <DistRow label="Around average (95–104)" value={minor} total={rated.length} tone="bg-amber-500" />
                <DistRow label="Rolls back (<95)" value={significant} total={rated.length} tone="bg-red-500" />
              </div>
              {scored.length >= MAX_BULLS && <p className="mt-2 text-[11px] text-amber-600">Showing first {fmtNum(MAX_BULLS)} multi-round bulls.</p>}
            </Card>

            <Card title="Retention by trait" className="lg:col-span-2">
              <div className="mb-1 grid grid-cols-[1fr_auto_auto] gap-x-6 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <span>Trait</span><span className="text-right">All rounds</span><span className="text-right">April only</span>
              </div>
              <div className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm md:grid-cols-2">
                {traitRows.map((t) => (
                  <div key={t.code} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6" title={`Worst single round-to-round step seen in the lineup: ${t.worst}%`}>
                    <span className="text-slate-600">{ROLLBACK_TRAIT_LABELS[t.code] ?? t.code}</span>
                    <span className="w-12 text-right tabular-nums text-slate-500">{t.perf}</span>
                    <span className={`w-12 text-right font-semibold tabular-nums ${t.rb == null ? "text-slate-300" : t.rb >= 99 ? "text-brand-700" : t.rb >= 97 ? "text-amber-600" : "text-red-600"}`}>{t.rb ?? "—"}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Mean retention per step. The April column is what Rollback Resistance is built from — lower means the
                trait gives more back at each base change. Sampled from the {fmtNum(traitSampleN)} bulls with the
                deepest April history, not the whole lineup, so the page stays fast.
              </p>
            </Card>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Leaderboard title="Best holders (highest rating)" rows={bestHolders} />
            <Leaderboard title="Biggest rollbacks (lowest rating)" rows={biggestRollback} />
          </div>
        </>
      ))}
    </div>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return <Link href={href} className={`rounded-full px-4 py-1.5 font-medium ${active ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>{label}</Link>;
}

function DistRow({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs"><span>{label}</span><span className="text-slate-500">{value} ({pct}%)</span></div>
      <div className="h-2 w-full rounded-full bg-slate-100"><div className={`h-2 rounded-full ${tone}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

type ScoredRow = {
  a: {
    id: string; primaryName: string; proofRoundCount: number;
    proofPerformance: number | null; proofSteps: number | null;
    rollbackSteps: number | null;
  };
  resistance: number | null;
  rv: { label: string; tone: "good" | "warn" | "danger" | "slate" } | null;
};

function Leaderboard({ title, rows }: { title: string; rows: ScoredRow[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? <EmptyState message="No bull here has been through an April base change yet." /> : (
        <Table head={<>
          <th className="th">Bull</th>
          <th className="th" title="Proof rounds on file">Rounds</th>
          <th className="th" title="Mean retention across every consecutive pair of rounds, out of 100">Proof Perf.</th>
          <th className="th" title="April rounds only, base 100 = lineup average, 5 points = 1 standard deviation">Rollback Res.</th>
          <th className="th">Vs lineup</th>
        </>}>
          {rows.map((x) => (
            <tr key={x.a.id}>
              <td className="td"><Link href={`/animals/${x.a.id}`} className="link font-medium">{x.a.primaryName}</Link></td>
              <td className="td text-xs text-slate-500" title={`${x.a.proofSteps ?? 0} round-to-round steps · ${x.a.rollbackSteps ?? 0} April step${x.a.rollbackSteps === 1 ? "" : "s"}`}>
                {x.a.proofRoundCount}
                <span className="ml-1 text-amber-600">({x.a.rollbackSteps ?? 0}A)</span>
              </td>
              <td className="td tabular-nums text-slate-600">{x.a.proofPerformance}</td>
              <td className={`td font-semibold tabular-nums ${x.resistance == null ? "text-slate-300" : x.resistance >= 105 ? "text-brand-700" : x.resistance < 95 ? "text-red-600" : "text-slate-700"}`}>{x.resistance ?? "—"}</td>
              <td className="td">{x.rv && <Badge tone={x.rv.tone === "good" ? "green" : x.rv.tone === "warn" ? "amber" : x.rv.tone === "danger" ? "red" : "slate"}>{x.rv.label}</Badge>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
