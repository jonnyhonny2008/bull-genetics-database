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
  const lpiMove = report.movement.find((m) => m.code === "LPI");

  return (
    <div>
      <PageHeader
        title="Movement Forecast"
        subtitle={`How far every NAAB bull could move in ${report.targetLabel}, and the odds on each — matched against the bulls who were at the same career stage. Latest round on file: ${report.latestLabel ?? "—"}.`}
        actions={<a href={exportHref} className="btn-primary">⬇ Export to Excel</a>}
      />

      {!report.targetIsApril && lpiMove && (
        <div className="mb-4 rounded-md border border-brand-200 bg-brand-50/60 px-3 py-2.5 text-sm text-slate-700">
          <strong className="text-slate-900">
            {report.targetLabel} is {report.targetKind === "official" ? "an official round" : "an interim round"}. About{" "}
            {Math.round(lpiMove.movedShare)}% of bulls will move on LPI, by {lpiMove.typicalMove} points on average.
          </strong>
          <div className="mt-1">
            Which <em>way</em> each bull moves is not forecastable, and that is not a shortcoming of this report —
            a published proof is already Lactanet&apos;s best estimate of the next one. Eight methods were tested against
            your own rounds (recent trend, mean reversion, cohort drift, seasonality, analogue matching,
            interim-to-official carry-over, cross-trait structure, and the lineup average itself); every one scored
            worse than simply carrying the current proof forward. So each projected value below is the current value,
            and <strong>the forecast is the range and the odds beside it</strong>.
          </div>
          <div className="mt-1">
            That part is genuinely predictable, and this model is{" "}
            <strong>{bt.overallRangeSkill != null ? `${bt.overallRangeSkill}%` : "measurably"} sharper</strong> than the
            single lineup-wide range this report used to publish — measured by holding back the last{" "}
            {bt.rangeRounds} rounds and re-forecasting them.
          </div>
          <div className="mt-1 text-[12px] text-slate-500">
            April base changes are excluded on purpose — a rollback moves every bull at once for reasons that have
            nothing to do with the bull, and gets its own report.
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Bulls forecast" value={fmtNum(report.compared)} hint={report.notComparable ? `${fmtNum(report.notComparable)} lack 2+ rounds` : undefined} tone="good" />
        {report.targetIsApril ? (
          <>
            <StatCard label="Projected to rise" value={fmtNum(report.risers)} hint="LPI up" tone="good" />
            <StatCard label="Projected to fall" value={fmtNum(report.fallers)} hint="LPI down" tone={report.fallers ? "danger" : "default"} />
            <StatCard label="Avg LPI change" value={report.avgLpiDelta != null ? `${report.avgLpiDelta > 0 ? "+" : ""}${report.avgLpiDelta}` : "—"} tone="accent" />
          </>
        ) : (
          <>
            <StatCard
              label="Likely to move materially"
              value={fmtNum(report.likelyToMove)}
              hint={lpiMove ? `LPI move over ${lpiMove.material}` : undefined}
              tone={report.likelyToMove > report.compared / 2 ? "danger" : "accent"}
            />
            <StatCard
              label="Typical LPI move"
              value={report.typicalLpiMove != null ? `±${report.typicalLpiMove}` : "—"}
              hint="median across the lineup"
              tone="accent"
            />
            <StatCard
              label="Range vs old model"
              value={bt.overallRangeSkill != null ? `${bt.overallRangeSkill > 0 ? "+" : ""}${bt.overallRangeSkill}%` : "—"}
              hint="sharper, backtested"
              tone={(bt.overallRangeSkill ?? 0) > 0 ? "good" : "warn"}
            />
          </>
        )}
      </div>

      {/* How the lineup behaves on this kind of round — the forecastable part */}
      {!report.targetIsApril && report.movement.length > 0 && (
        <Card className="mt-4" title={`What a ${report.targetKind === "official" ? "n official" : "n interim"} round does to this lineup`}>
          <p className="mb-3 text-sm text-slate-600">
            Measured over {fmtNum(report.movement[0]?.n ?? 0)} real {report.targetKind} rounds of your own bulls. This is
            the honest description of the uncertainty: a trait that hardly ever moves needs no wide range, and one that
            always moves cannot be pinned down.
          </p>
          <Table head={<>
            <th className="th">Trait</th>
            <th className="th text-right" title="Share of bulls whose value changed at all">Bulls that move</th>
            <th className="th text-right" title="Mean absolute change among all bulls">Typical move</th>
            <th className="th text-right" title="A change bigger than this counts as material — the median move size">Material move</th>
          </>}>
            {report.movement.map((m) => (
              <tr key={m.code}>
                <td className="td">{m.label}</td>
                <td className="td text-right tabular-nums">
                  <span className={m.movedShare >= 50 ? "font-semibold text-slate-800" : "text-slate-500"}>{m.movedShare}%</span>
                </td>
                <td className="td text-right tabular-nums text-slate-600">±{m.typicalMove}</td>
                <td className="td text-right tabular-nums text-slate-400">{m.material > 0 ? `±${m.material}` : "any change"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {/* Who is most exposed */}
      {report.mostExposed.length > 0 && (
        <Card className="mt-4" title="Most exposed to movement">
          <p className="mb-3 text-sm text-slate-600">
            The bulls whose analogues moved furthest. Worth watching before {report.targetLabel} lands — not because
            they will fall, but because they are the least settled.
          </p>
          <div className="flex flex-wrap gap-2">
            {report.mostExposed.map((b) => (
              <Link
                key={b.id}
                href={`/reports/proof-forecast?${new URLSearchParams({ ...tableParams, bull: b.id }).toString()}`}
                prefetch={false}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm transition hover:border-brand-300 hover:bg-brand-50/50"
              >
                <div className="font-medium text-slate-800">{b.name}</div>
                <div className="text-[11px] text-slate-500">
                  {b.naab ?? "—"} · ±{b.expectedMove} LPI · {b.pMove}% chance of a material move
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

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
              Solid = the lineup&apos;s actual average per round. The dashed {report.targetLabel} point is flat on purpose:
              individual bulls move in both directions and the average of those moves is not forecastable either — tested
              walk-forward, predicting the lineup&apos;s average drift scored worse than predicting no drift at all.
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
              The last <strong>{bt.rangeRounds} rounds</strong> were held back one at a time and re-forecast from only
              what was on file beforehand, across {fmtNum(bt.bulls)} bulls. <strong>Sharper</strong> is how much better
              the range scored than the single lineup-wide range this report used to publish, measured by CRPS — a rule
              that penalises a range both for missing and for being needlessly wide, so nothing wins by hedging.
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Range vs old model" value={bt.overallRangeSkill != null ? `${bt.overallRangeSkill > 0 ? "+" : ""}${bt.overallRangeSkill}%` : "—"} hint="sharper (CRPS)" tone={(bt.overallRangeSkill ?? 0) > 0 ? "good" : "warn"} />
              <StatCard label="Rounds tested" value={String(bt.rangeRounds)} hint={`newest: ${bt.roundLabel ?? "—"}`} />
              <StatCard label="Bulls tested" value={fmtNum(bt.bulls)} />
              <StatCard label="Direction skill" value={bt.overallSkill != null ? `${bt.overallSkill > 0 ? "+" : ""}${bt.overallSkill}%` : "—"} hint="expected: none" tone="default" />
            </div>
            <div className="mt-3">
              <Table head={<>
                <th className="th">Trait</th>
                <th className="th text-right">Forecasts</th>
                <th className="th text-right" title="Continuous ranked probability score of this model's range — lower is better">Range score</th>
                <th className="th text-right" title="The same score for the single lineup-wide range this replaces">Old model</th>
                <th className="th text-right">Sharper by</th>
                <th className="th text-right" title="Share of the tested rounds where this trait did not change at all">Didn&apos;t move</th>
              </>}>
                {bt.traits.filter((t) => t.rangeN > 0).map((t) => (
                  <tr key={t.code}>
                    <td className="td">{t.label}</td>
                    <td className="td text-right tabular-nums text-slate-500">{fmtNum(t.rangeN)}</td>
                    <td className="td text-right font-semibold tabular-nums">{t.crps}</td>
                    <td className="td text-right tabular-nums text-slate-500">{t.cohortCrps}</td>
                    <td className={`td text-right font-semibold tabular-nums ${t.rangeSkill > 0 ? "text-emerald-700" : "text-red-600"}`}>{t.rangeSkill > 0 ? "+" : ""}{t.rangeSkill}%</td>
                    <td className="td text-right tabular-nums text-slate-400">{t.zeroShare}%</td>
                  </tr>
                ))}
              </Table>
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              <strong>Direction skill is zero by design.</strong> The projected value is the current value, because no
              method tested could beat that — so it ties, exactly, and the whole forecast is the range.
              The last column is why coverage is not quoted against a target here: where a trait does not move for most
              bulls, the range collapses onto &ldquo;no change&rdquo; and the actual lands on its edge rather than inside
              it. Six recalibration schemes were tried to force the range to a nominal 80%; every one made the forecast
              worse, so the ranges are published as measured.
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
            {report.focus.forecast.exposureBand && (
              <Badge tone={report.focus.forecast.exposureBand === "exposed" ? "amber" : report.focus.forecast.exposureBand === "steady" ? "green" : "slate"}>
                {report.focus.forecast.exposureBand}
                {report.focus.forecast.expectedLpiMove != null ? ` · ±${report.focus.forecast.expectedLpiMove} LPI` : ""}
              </Badge>
            )}
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

          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Full profile and the odds</div>
          <p className="mb-2 text-[11px] text-slate-400">
            Every index and linear trait for {report.targetLabel}, with the range he could land in and — for the nine key
            traits — how his analogues actually split between moving up, holding, and moving down.
          </p>
          <div className="overflow-x-auto">
            <Table head={<>
              <th className="th">Trait</th>
              <th className="th">Category</th>
              <th className="th text-right">Current</th>
              <th className="th text-right">Range</th>
              <th className="th text-right" title="Mean absolute move among his analogues">Typical move</th>
              <th className="th text-right" title="Chance of a material move up">Up</th>
              <th className="th text-right" title="Chance of holding within a material move">Holds</th>
              <th className="th text-right" title="Chance of a material move down">Down</th>
            </>}>
              {report.focus.forecast.allForecasts.map((t) => {
                const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
                return (
                  <tr key={t.code} className={t.key ? "bg-brand-50/40" : undefined}>
                    <td className="td">{t.name}{t.key && <span className="ml-1.5 text-[10px] uppercase text-brand-600">key</span>}</td>
                    <td className="td text-xs text-slate-500">{t.category ?? "—"}</td>
                    <td className="td text-right tabular-nums text-slate-600">{t.current ?? "—"}</td>
                    <td className="td text-right font-semibold tabular-nums">{t.lo != null ? `${t.lo} – ${t.hi}` : "—"}</td>
                    <td className="td text-right tabular-nums text-slate-500">{t.expectedMove != null ? `±${t.expectedMove}` : "—"}</td>
                    <td className="td text-right tabular-nums text-emerald-700">{pct(t.pUp)}</td>
                    <td className="td text-right tabular-nums text-slate-500">{pct(t.pSteady)}</td>
                    <td className="td text-right tabular-nums text-red-600">{pct(t.pDown)}</td>
                  </tr>
                );
              })}
            </Table>
          </div>
        </Card>
      )}

      {/* Filters */}
      <form method="get" className="card card-pad mt-4 flex flex-wrap items-end gap-3">
        {searchParams.ctrait && <input type="hidden" name="ctrait" value={searchParams.ctrait} />}
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
            {!report.targetIsApril && <option value="exposure">Movement exposure</option>}
            {KEY_TRAITS.map((t) => (
              <option key={t.code} value={t.code.toLowerCase()}>
                {t.label} {report.targetIsApril ? "change" : "movement"}
              </option>
            ))}
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
              Showing {fmtNum(report.rows.length)} of {fmtNum(report.compared)} bulls for <strong>{report.targetLabel}</strong>.
              {report.targetIsApril
                ? " Each cell is the projected change and the projected value."
                : " Each cell is the range he could land in and the chance he moves materially — the value itself is unchanged, because direction is not forecastable."}{" "}
              Expand a bull with <strong>+</strong> for his full profile, or click his name to pin it.
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
