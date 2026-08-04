import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { PageHeader, Card, Table, Badge, EmptyState, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { computeRollback, baselineOf, relativeRating, ratingVerdict, ROLLBACK_TRAIT_LABELS, isOfficialProof, isRollbackRound, type RollbackResult } from "@/lib/rollback";
import { attachTraits, traitDefMap } from "@/lib/eval-traits";
import { LineChart, CompareBars, type LineSeries } from "@/components/TrendCharts";
import { SireRolePills, SireRoleField, SireSortField, BlondinToggle } from "@/components/SireFilters";
import { sireRoleWhere, blondinWhere, resolveSort } from "@/lib/sire-class";
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
  // Blondin house bulls (an AnimalRole tag) vs the wider Lactanet population.
  // One push covers every query on the page: animalWhere and scoredWhere both
  // build on animalAND, and the nested `animal:` filters reuse animalWhere.
  const blondin = blondinWhere(sp.blondin);
  if (blondin) animalAND.push(blondin);
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
    // and the inactive toggle and count the whole non-archived herd — narrowed
    // to the Blondin bulls when that toggle is on, since it sits above them.
    sireRoleCounts(blondin ? { AND: [{ archived: false }, blondin] } : { archived: false }),
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

  // Multi-sire selection (up to 5), by career STAGE. Each sire's proof rounds
  // are indexed 1..N (round 1 = their first proof), so bulls that debuted in
  // different years line up at the same point in their active life.
  const col = chartTrait.col;
  // Career-stage basis: align sires by their Nth proof round, Nth official proof
  // (by recorded runKind, not the month), or Nth rollback (April base change). This is
  // what makes "a sire at its 2nd rollback" comparable to every other sire at
  // THEIR 2nd rollback, rather than comparing by calendar date.
  // Default alignment is Rollback (April rounds) — this page is framed around
  // Rollback Resistance, and it's the comparison the user cares about most.
  const alignBy = sp.align === "proof" ? "proof" : sp.align === "official" ? "official" : "rollback";
  // A round counts as "official" from its recorded runKind — not the month —
  // falling back to the calendar only for rows imported before the field existed.
  const officialRow = (e: { evaluationDate: Date; runKind?: string | null }) =>
    e.runKind === "official" || (e.runKind == null && isOfficialProof(e.evaluationDate));
  const basisMatch = (e: { evaluationDate: Date; runKind?: string | null }) =>
    alignBy === "rollback" ? isRollbackRound(e.evaluationDate) : alignBy === "official" ? officialRow(e) : true;
  const stageNoun = alignBy === "rollback" ? "rollback (April round)" : alignBy === "official" ? "official proof" : "proof round";
  const xUnit = alignBy === "rollback" ? "Rollback " : alignBy === "official" ? "Official proof " : "Proof round ";
  const MAX_SIRES = 5;
  const rawIds = (sp.bulls ?? sp.bull ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let selectedIds = Array.from(new Set(rawIds)).filter((id) => pickerBulls.some((b) => b.id === id)).slice(0, MAX_SIRES);
  // "add" a sire by name — server-driven multi-select, no client JS needed.
  const addName = (sp.add ?? "").trim();
  let addNotFound = false;
  if (addName && selectedIds.length < MAX_SIRES) {
    const match = pickerBulls.find((b) => b.name.toLowerCase() === addName.toLowerCase())
      ?? pickerBulls.find((b) => b.name.toLowerCase().includes(addName.toLowerCase()));
    if (match) { if (!selectedIds.includes(match.id)) selectedIds.push(match.id); }
    else addNotFound = true;
  }
  // Default to the first sire so the chart isn't empty on first open.
  if (selectedIds.length === 0 && pickerBulls[0]) selectedIds = [pickerBulls[0].id];

  const evalSelect = { evaluationDate: true, runKind: true, [col]: true } as Prisma.GeneticEvaluationSelect;
  const selBulls = view === "charts" && selectedIds.length
    ? await prisma.animal.findMany({
        where: { id: { in: selectedIds } },
        select: { id: true, primaryName: true, evaluations: { orderBy: { evaluationDate: "asc" }, select: evalSelect } },
      })
    : [];
  const selById = new Map(selBulls.map((b) => [b.id, b]));
  const orderedSel = selectedIds.map((id) => selById.get(id)).filter((b): b is (typeof selBulls)[number] => !!b);

  // Stage-aligned lineup average: the average of the trait at each career stage
  // across the whole population (active unless the inactive toggle is on).
  const avgRows = view === "charts"
    ? await prisma.geneticEvaluation.findMany({
        where: { animal: animalWhere },
        select: { animalId: true, evaluationDate: true, runKind: true, [col]: true } as Prisma.GeneticEvaluationSelect,
        orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
      })
    : [];
  const stageSum: number[] = []; const stageCnt: number[] = [];
  {
    let cur: string | null = null; let stage = 0;
    for (const row of avgRows) {
      const r = row as unknown as { animalId: string; evaluationDate: Date; runKind?: string | null; [k: string]: unknown };
      if (r.animalId !== cur) { cur = r.animalId; stage = 0; }
      if (!basisMatch(r)) continue; // interim rounds don't advance an official / rollback stage
      const v = r[col];
      if (typeof v === "number") { stageSum[stage] = (stageSum[stage] ?? 0) + v; stageCnt[stage] = (stageCnt[stage] ?? 0) + 1; }
      stage++;
    }
  }

  const SERIES_COLORS = ["#2f6551", "#d97706", "#2563eb", "#7c3aed", "#dc2626"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const roundLabel = (e: { evaluationDate?: Date } | undefined) => {
    const d = e?.evaluationDate; return d ? `${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}` : "";
  };
  // Each sire's rounds on the chosen basis, oldest first.
  const selRounds = orderedSel.map((b) => b.evaluations.filter((e) => basisMatch(e as unknown as { evaluationDate: Date; runKind?: string | null })));
  const maxStage = Math.max(0, ...selRounds.map((r) => r.length));
  const xs = Array.from({ length: maxStage }, (_, i) => `${i + 1}`);
  const sireSeries: LineSeries[] = orderedSel.map((b, idx) => ({
    label: b.primaryName,
    color: SERIES_COLORS[idx % SERIES_COLORS.length],
    points: xs.map((x, i) => {
      const e = selRounds[idx][i] as unknown as { evaluationDate?: Date; [k: string]: unknown } | undefined;
      const y = e ? e[col] : null;
      return { x, y: typeof y === "number" ? y : null, note: e ? roundLabel(e) : undefined };
    }),
  }));
  const avgSeries: LineSeries = {
    label: `Lineup average (${includeInactive ? "all" : "active"})`,
    color: "#94a3b8", dashed: true,
    points: xs.map((x, i) => ({ x, y: stageCnt[i] ? Math.round(stageSum[i] / stageCnt[i]) : null, note: stageCnt[i] ? `${stageCnt[i]} sires` : undefined })),
  };
  const trendSeries: LineSeries[] = maxStage ? [...sireSeries, avgSeries] : [];

  // Single-sire extra: the familiar bull-vs-lineup bars, only when exactly one
  // sire is selected (across-all-traits view for a single bull's latest proof).
  const singleSel = orderedSel.length === 1 ? orderedSel[0] : null;
  const singlePref = singleSel
    ? (await prisma.geneticEvaluation.findFirst({ where: { animalId: singleSel.id, isPreferred: true } })
      ?? await prisma.geneticEvaluation.findFirst({ where: { animalId: singleSel.id }, orderBy: { evaluationDate: "desc" } }))
    : null;
  const compareRows = singlePref ? CHART_TRAITS.map((t) => ({
    label: t.label,
    a: (singlePref[t.col as keyof typeof singlePref] as number | null) ?? null,
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
  const popLabel = (sp.role
    ? `${sp.role} sires`
    : includeInactive ? "all sires (active + inactive)" : "active sires only")
    + (sp.blondin === "1" ? " · Blondin bulls only" : "");

  // Build a charts URL for a specific set of selected sire ids, preserving the
  // trait, alignment basis, role, sort and inactive filters.
  const chartsUrl = (ids: string[], extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    p.set("view", "charts");
    if (ids.length) p.set("bulls", ids.join(","));
    p.set("trait", chartTrait.code);
    p.set("align", alignBy);
    if (sp.role) p.set("role", sp.role);
    if (sp.blondin) p.set("blondin", sp.blondin);
    if (sp.sort) p.set("sort", sp.sort);
    if (sp.dir) p.set("dir", sp.dir);
    if (includeInactive) p.set("includeInactive", "1");
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/analysis?${p.toString()}`;
  };

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
        <BlondinToggle basePath="/analysis" sp={sp} />
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
        {selectedIds.length > 0 && <input type="hidden" name="bulls" value={selectedIds.join(",")} />}
        <input type="hidden" name="align" value={alignBy} />
        <input type="hidden" name="trait" value={chartTrait.code} />
        <SireRoleField value={sp.role} />
        <SireSortField sort={sp.sort} dir={sp.dir} />
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Inactive sires no longer appear in the most recent round, so they are left out by default.">
          <input type="checkbox" name="includeInactive" value="1" defaultChecked={includeInactive} />
          Include inactive sires
        </label>
        {/* Mirrors the pill toggle above, and keeps it alive when this form is
            submitted — a GET form only sends its own fields. */}
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Blondin bulls are the stud's own house bulls, as opposed to the wider Lactanet population.">
          <input type="checkbox" name="blondin" value="1" defaultChecked={sp.blondin === "1"} />
          Blondin bulls only
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
              <Card title="Compare sires by career stage">
                {/* Selected sires (up to 5) as removable chips */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {orderedSel.map((b, idx) => (
                    <span key={b.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-1 pl-2 pr-1 text-xs">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SERIES_COLORS[idx % SERIES_COLORS.length] }} />
                      <Link href={`/animals/${b.id}`} className="font-medium text-slate-700 hover:text-brand-700">{b.primaryName}</Link>
                      <a href={chartsUrl(selectedIds.filter((id) => id !== b.id))} title="Remove" className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700">×</a>
                    </span>
                  ))}
                  {orderedSel.length === 0 && <span className="text-xs text-slate-400">No sires selected.</span>}
                </div>

                {/* Add a sire (up to 5), pick the trait, and the career-stage basis */}
                <form method="get" className="mb-3 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="view" value="charts" />
                  {selectedIds.length > 0 && <input type="hidden" name="bulls" value={selectedIds.join(",")} />}
                  {sp.role && <input type="hidden" name="role" value={sp.role} />}
                  {sp.blondin && <input type="hidden" name="blondin" value={sp.blondin} />}
                  {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
                  {sp.dir && <input type="hidden" name="dir" value={sp.dir} />}
                  {includeInactive && <input type="hidden" name="includeInactive" value="1" />}
                  <div>
                    <label className="label" htmlFor="add-sire">Add a sire ({selectedIds.length}/{MAX_SIRES})</label>
                    <input id="add-sire" name="add" list="bull-options" autoComplete="off" placeholder="Type a name…" disabled={selectedIds.length >= MAX_SIRES} className="input min-w-[240px] disabled:bg-slate-50" />
                    <datalist id="bull-options">
                      {pickerBulls.filter((b) => !selectedIds.includes(b.id)).map((b) => <option key={b.id} value={b.name} />)}
                    </datalist>
                  </div>
                  <div>
                    <label className="label">Trait</label>
                    <select name="trait" defaultValue={chartTrait.code} className="input">
                      {CHART_TRAITS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Align by</label>
                    <select name="align" defaultValue={alignBy} className="input">
                      <option value="proof">Proof round (all)</option>
                      <option value="official">Official proof only</option>
                      <option value="rollback">Rollback (April)</option>
                    </select>
                  </div>
                  <button type="submit" className="btn-primary">Add / update</button>
                  {selectedIds.length > 0 && <a href={chartsUrl([])} className="btn-secondary">Clear</a>}
                </form>
                {addNotFound && (
                  <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    No sire matching &ldquo;{addName}&rdquo; in the current filter. Check the spelling, or widen the sire role / inactive filters above.
                  </p>
                )}
                {selectedIds.length >= MAX_SIRES && <p className="mb-3 text-[11px] text-amber-600">Up to {MAX_SIRES} sires at once — remove one to add another.</p>}

                {trendSeries.length > 0 ? (
                  <div className="space-y-6">
                    <div>
                      <div className="mb-2 text-sm font-semibold text-slate-700">{chartTrait.label} by {stageNoun} (career stage)</div>
                      <div className="rounded-lg border border-slate-100 bg-white px-2 py-3 sm:px-4 sm:py-4">
                        <LineChart series={trendSeries} yLabel={chartTrait.label} xUnit={xUnit} />
                      </div>
                      <p className="mt-2 text-[11px] text-slate-400">
                        The x-axis is each sire&apos;s {stageNoun} number — stage 1 is their first {stageNoun}, so sires that debuted in different years line up at the same point in their career. The dashed line is the {includeInactive ? "whole" : "active"} lineup&apos;s average at that same stage (every sire compared at their 2nd, 3rd, … {stageNoun}). Whether a proof is official or interim comes from the file Lactanet shipped it in, not the month{alignBy === "proof" ? " — both are counted here" : alignBy === "official" ? " — interims are skipped" : " — only April rollbacks are counted"}. Hover for values; click a legend label to toggle a line.
                      </p>
                    </div>
                    {singleSel && compareRows.length > 0 && (
                      <div className="lg:max-w-2xl">
                        <div className="mb-2 text-sm font-semibold text-slate-700">{singleSel.primaryName} vs lineup average (latest proof)</div>
                        <CompareBars rows={compareRows} aLabel={singleSel.primaryName} bLabel={includeInactive ? "Lineup avg (all)" : "Lineup avg (active)"} />
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState message={`Add one or more sires above to chart them by ${stageNoun}.`} />
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
