import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, EmptyState, StatCard, Badge, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getProofForecastReport, KEY_TRAITS } from "@/lib/proof-forecast";
import { ProofForecastTable } from "@/components/ProofForecastTable";
import { LineChart, type LineSeries } from "@/components/TrendCharts";

export const dynamic = "force-dynamic";

export default async function ProofForecastReportPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const report = await getProofForecastReport(searchParams);

  const exportParams = new URLSearchParams();
  for (const k of ["q", "breed", "blondin", "sort", "dir", "conf", "target"]) {
    const v = searchParams[k];
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/reports/proof-forecast/export${exportParams.toString() ? `?${exportParams}` : ""}`;

  const tableParams: Record<string, string> = {};
  for (const k of ["q", "breed", "blondin", "conf", "ctrait", "target"]) {
    const v = searchParams[k];
    if (v) tableParams[k] = v;
  }

  // Lineup trend chart: history solid, the projected round as a dashed series
  // that joins the last real point so the projection reads as a continuation.
  const lastRealIdx = report.trend.map((p) => p.projected).lastIndexOf(false);
  const trendSeries: LineSeries[] = report.trend.length > 1 ? [
    {
      label: `Lineup average ${report.chartTrait.label}`,
      color: "#16a085",
      points: report.trend.map((p) => ({ x: p.label, y: p.projected ? null : p.value, note: `${fmtNum(p.bulls)} bulls` })),
    },
    {
      label: `Projected ${report.targetLabel}`,
      color: "#e67e22",
      dashed: true,
      points: report.trend.map((p, i) => ({
        x: p.label,
        y: p.projected || i === lastRealIdx ? p.value : null,
        note: p.projected ? "projection" : undefined,
      })),
    },
  ] : [];

  const bt = report.backtest;

  return (
    <div>
      <PageHeader
        title="Projected Proof Report"
        subtitle={`A modelled ${report.targetLabel} proof for every NAAB bull — projected from trend, reliability and how the lineup behaves on this kind of round. Latest round on file: ${report.latestLabel ?? "—"}.`}
        actions={<a href={exportHref} className="btn-primary">⬇ Export to Excel</a>}
      />

      {report.targetIsApril ? (
        <div className="mb-4 rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-900">
          <strong>{report.targetLabel} is an April round — the annual base change.</strong>{" "}
          {report.basePublished
            ? <>Lactanet has <strong>published</strong> the base change for this April, so the projection applies the real
              per-breed shift rather than an estimate. When the base rises, every bull&apos;s published value falls by that
              amount with no new information about the bull — that is the rollback.</>
            : <>Lactanet has not published this April&apos;s base change yet, so the projection applies the most recent
              published table. Expect the magnitudes to shift a little when the new one lands.</>}
          <div className="mt-1 text-[12px]">
            Note: <strong>LPI does not move on a base change</strong> — Lactanet absorbs it into the constant in the LPI
            formula — so LPI shows no April change by design. The rollback shows up in Milk, Fat, Protein and Conformation.
          </div>
        </div>
      ) : (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <strong>{report.targetLabel} is an ordinary round — no base change.</strong> Bulls&apos; profiles certainly move
          every round, but the <em>direction</em> of that move is not forecastable: tested one step ahead over 6,159
          predictions on your own data — split by reliability, by history depth, and by whether the bull moved last round —
          following the interim trend came out <em>worse</em> than carrying the current proof forward, every time. That is
          what an unbiased evaluation implies: each round&apos;s change is new information.
          <div className="mt-1">
            So the projection for {report.targetLabel} is each bull&apos;s current profile, and the real content is the{" "}
            <strong>range</strong> — how far each trait typically moves in one round, calibrated from your rounds
            (about {bt.overallCoverage != null ? `${bt.overallCoverage}%` : "80%"} of actual values land inside it).
            Use it to see where surprises can come from. The <strong>April</strong> round is the one that is genuinely
            predictable — switch &ldquo;Project to&rdquo; below.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Bulls projected" value={fmtNum(report.compared)} hint={report.notComparable ? `${fmtNum(report.notComparable)} lack 2+ rounds` : undefined} tone="good" />
        <StatCard label="Projected to rise" value={fmtNum(report.risers)} hint="LPI up" tone="good" />
        <StatCard label="Projected to fall" value={fmtNum(report.fallers)} hint="LPI down" tone={report.fallers ? "danger" : "default"} />
        <StatCard label="Avg LPI change" value={report.avgLpiDelta != null ? `${report.avgLpiDelta > 0 ? "+" : ""}${report.avgLpiDelta}` : "—"} tone="accent" />
      </div>

      {/* Trend + projection chart */}
      <Card
        className="mt-4"
        title={`Lineup average ${report.chartTrait.label} — history and projection`}
        actions={
          <div className="flex flex-wrap gap-1">
            {KEY_TRAITS.map((t) => {
              const p = new URLSearchParams(tableParams);
              p.set("ctrait", t.code);
              if (report.sort) p.set("sort", report.sort);
              if (report.dir) p.set("dir", report.dir);
              return (
                <Link
                  key={t.code}
                  href={`/reports/proof-forecast?${p.toString()}`}
                  prefetch={false}
                  scroll={false}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${report.chartTrait.code === t.code ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                >
                  {t.label}
                </Link>
              );
            })}
          </div>
        }
      >
        {trendSeries.length ? (
          <>
            <LineChart series={trendSeries} height={260} yLabel={report.chartTrait.label} />
            <p className="mt-2 text-[11px] text-slate-400">
              Solid = the lineup&apos;s actual average per round. Dashed orange = the projected {report.targetLabel} average
              across {fmtNum(report.compared)} bulls.
            </p>
          </>
        ) : (
          <EmptyState message="Not enough rounds on file to chart a trend yet." />
        )}
      </Card>

      {/* Accuracy — the report shows its own track record */}
      <Card className="mt-4" title="How accurate is this? (backtest)">
        {bt.ran ? (
          <>
            <p className="mb-3 text-sm text-slate-600">
              Every bull&apos;s <strong>most recent round ({bt.roundLabel})</strong> was held back, predicted from the
              rounds before it, then compared with what actually happened — across {fmtNum(bt.bulls)} bulls with enough
              history. <strong>Skill</strong> is how much closer the model landed than simply assuming nothing changes;
              <strong> coverage</strong> is how often the real value fell inside the projected range (80% is the target).
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Overall skill vs no-change" value={bt.overallSkill != null ? `${bt.overallSkill > 0 ? "+" : ""}${bt.overallSkill}%` : "—"} tone={(bt.overallSkill ?? 0) > 0 ? "good" : "warn"} />
              <StatCard label="Range coverage" value={bt.overallCoverage != null ? `${bt.overallCoverage}%` : "—"} hint="target 80%" tone={bt.overallCoverage != null && bt.overallCoverage >= 70 ? "good" : "warn"} />
              <StatCard label="Round tested" value={bt.roundLabel ?? "—"} />
              <StatCard label="Bulls tested" value={fmtNum(bt.bulls)} />
            </div>
            <div className="mt-3">
              <Table head={<>
                <th className="th">Trait</th>
                <th className="th text-right">Bulls</th>
                <th className="th text-right" title="Mean absolute error of the projection">Avg error</th>
                <th className="th text-right" title="Mean absolute error of assuming no change at all">If unchanged</th>
                <th className="th text-right">Skill</th>
                <th className="th text-right">Coverage</th>
              </>}>
                {bt.traits.map((t) => (
                  <tr key={t.code}>
                    <td className="td">{t.label}</td>
                    <td className="td text-right tabular-nums text-slate-500">{fmtNum(t.n)}</td>
                    <td className="td text-right font-semibold tabular-nums">{t.mae}</td>
                    <td className="td text-right tabular-nums text-slate-500">{t.naiveMae}</td>
                    <td className={`td text-right font-semibold tabular-nums ${t.skill > 0 ? "text-emerald-700" : "text-red-600"}`}>{t.skill > 0 ? "+" : ""}{t.skill}%</td>
                    <td className={`td text-right tabular-nums ${t.coverage >= 70 ? "text-slate-700" : "text-amber-600"}`}>{t.coverage}%</td>
                  </tr>
                ))}
              </Table>
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              A negative skill means that trait is better predicted by assuming no change — read those projections as
              &ldquo;expect roughly the current value&rdquo;. Nothing here can foresee a bull&apos;s new daughter crop or a
              change to the index formula; that uncertainty is what the range is for.
            </p>
          </>
        ) : (
          <EmptyState message="Not enough bulls with three or more rounds to measure accuracy yet. Import another proof round and this panel fills in automatically." />
        )}
      </Card>

      {/* Single-bull full profile */}
      {report.focus && (
        <Card
          className="mt-4"
          title={`Projected profile — ${report.focus.name}`}
          actions={<Link href={`/reports/proof-forecast?${new URLSearchParams(tableParams).toString()}`} prefetch={false} className="link text-xs">Clear ✕</Link>}
        >
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="brand">{report.focus.naab ?? report.focus.reg ?? "—"}</Badge>
            <span className="text-slate-500">{report.focus.forecast.roundsOnFile} rounds on file</span>
            <span className="text-slate-500">Reliability {report.focus.forecast.reliability != null ? `${Math.round(report.focus.forecast.reliability * 100)}%` : "—"}</span>
            <Badge tone={report.focus.forecast.confidence === "high" ? "green" : report.focus.forecast.confidence === "medium" ? "amber" : "slate"}>
              {report.focus.forecast.confidence} confidence
            </Badge>
            <Link href={`/animals/${report.focus.id}`} className="link">Open bull profile →</Link>
          </div>

          {report.focusSeries.length > 0 && (
            <div className="mb-4">
              <LineChart
                height={240}
                yLabel="Key traits (history → projection)"
                series={report.focusSeries.slice(0, 4).map((s, i) => ({
                  label: s.label,
                  color: ["#16a085", "#e67e22", "#2563eb", "#7c3aed"][i % 4],
                  points: [
                    ...s.points.map((p) => ({ x: p.label, y: p.value })),
                    { x: report.targetLabel, y: s.predicted, note: s.lo != null ? `range ${s.lo}–${s.hi}` : undefined },
                  ],
                }))}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                The final point on each line is the projected {report.targetLabel} value. Hover for the range.
              </p>
            </div>
          )}

          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Full projected profile</div>
          <p className="mb-2 text-[11px] text-slate-400">Every index and linear trait: current → projected ({report.targetLabel}), with the 80% range.</p>
          <div className="overflow-x-auto">
            <Table head={<>
              <th className="th">Trait</th>
              <th className="th">Category</th>
              <th className="th text-right">Current</th>
              <th className="th text-right">Projected</th>
              <th className="th text-right">Change</th>
              <th className="th text-right">Range</th>
            </>}>
              {report.focus.forecast.allForecasts.map((t) => (
                <tr key={t.code} className={t.key ? "bg-brand-50/40" : undefined}>
                  <td className="td">{t.name}{t.key && <span className="ml-1.5 text-[10px] uppercase text-brand-600">key</span>}</td>
                  <td className="td text-xs text-slate-500">{t.category ?? "—"}</td>
                  <td className="td text-right tabular-nums text-slate-600">{t.current ?? "—"}</td>
                  <td className="td text-right font-semibold tabular-nums">{t.predicted ?? "—"}</td>
                  <td className={`td text-right font-semibold tabular-nums ${t.delta == null || t.delta === 0 ? "text-slate-400" : t.delta > 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {t.delta == null ? "—" : `${t.delta > 0 ? "+" : ""}${t.delta}`}
                  </td>
                  <td className="td text-right text-xs tabular-nums text-slate-400">{t.lo != null ? `${t.lo} – ${t.hi}` : "—"}</td>
                </tr>
              ))}
            </Table>
          </div>
        </Card>
      )}

      {/* Filters */}
      <form method="get" className="card card-pad mt-4 flex flex-wrap items-end gap-3">
        {searchParams.ctrait && <input type="hidden" name="ctrait" value={searchParams.ctrait} />}
        <div>
          <label className="label" title="Ordinary rounds carry no base change, so projections hold steady. The April round is the base change — the one worth previewing.">Project to</label>
          <select name="target" defaultValue={report.target} className="input min-w-[190px]">
            <option value="">Next round on cadence</option>
            <option value="april">Next April (base change)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="q">Find a bull</label>
          <input id="q" name="q" defaultValue={report.q} placeholder="Name, NAAB, or reg…" className="input min-w-[220px]" />
        </div>
        <div>
          <label className="label">Breed</label>
          <select name="breed" defaultValue={report.breed} className="input">
            <option value="">All breeds</option>
            {report.breeds.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Sort by</label>
          <select name="sort" defaultValue={report.sort} className="input">
            {KEY_TRAITS.map((t) => <option key={t.code} value={t.code.toLowerCase()}>{t.label} change</option>)}
            <option value="confidence">Confidence</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div>
          <label className="label">Order</label>
          <select name="dir" defaultValue={report.dir} className="input">
            <option value="desc">Biggest first</option>
            <option value="asc">Smallest first</option>
          </select>
        </div>
        <div>
          <label className="label" title="Confidence reflects rounds on file, reliability, and whether an April base change is being predicted.">Confidence</label>
          <select name="conf" defaultValue={report.minConfidence} className="input">
            <option value="">Any</option>
            <option value="medium">Medium and high</option>
            <option value="high">High only</option>
          </select>
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600">
          <input type="checkbox" name="blondin" value="1" defaultChecked={report.blondin === "1"} />
          Blondin bulls only
        </label>
        <button type="submit" className="btn-primary">Apply</button>
        <a href="/reports/proof-forecast" className="btn-secondary">Reset</a>
      </form>

      <div className="mt-4">
        {report.rows.length === 0 ? (
          <Card title="Projections">
            <EmptyState message={
              report.compared === 0
                ? "No NAAB bulls have two or more proof rounds yet — a projection needs at least two rounds to read a trend."
                : "No bulls match the current filters. Widen the search or clear the filters."
            } />
          </Card>
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              Showing {fmtNum(report.rows.length)} of {fmtNum(report.compared)} bulls, projected to <strong>{report.targetLabel}</strong>.
              Each cell is the projected change and the projected value; expand a bull with <strong>+</strong> for his full
              projected profile, or search a bull above and click his name in the table to pin the full view.
              Cohort: {report.cohortLabel}.
            </p>
            {/* Pin one bull's full profile: link each row through ?bull=<id>. */}
            {!report.focus && report.rows.length > 0 && report.q && (
              <p className="mb-2 text-xs text-slate-500">
                {report.rows.slice(0, 5).map((r) => {
                  const p = new URLSearchParams(tableParams);
                  p.set("bull", r.id);
                  return (
                    <Link key={r.id} href={`/reports/proof-forecast?${p.toString()}`} prefetch={false} className="link mr-3">
                      View {r.name}&apos;s full projected profile →
                    </Link>
                  );
                })}
              </p>
            )}
            <ProofForecastTable
              rows={report.rows}
              keyTraits={KEY_TRAITS}
              sort={report.sort}
              dir={report.dir}
              params={tableParams}
              basePath="/reports/proof-forecast"
            />
          </>
        )}
      </div>
    </div>
  );
}
