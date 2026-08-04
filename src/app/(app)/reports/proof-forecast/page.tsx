import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, EmptyState, StatCard, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getProofForecastReport, KEY_TRAITS } from "@/lib/proof-forecast";
import { ProofForecastTable } from "@/components/ProofForecastTable";

export const dynamic = "force-dynamic";
// Matching every bull against the lineup's whole history, plus backtesting the
// last six rounds, takes several seconds on a cold request — comfortably past
// the default serverless ceiling. The backtest is memoised, so only the first
// request after a deploy or an import pays full price.
export const maxDuration = 60;

export default async function ProofForecastReportPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const report = await getProofForecastReport(searchParams);

  // Preserve current filters/sort on the Excel export link.
  const exportParams = new URLSearchParams();
  for (const k of ["q", "breed", "blondin", "sort", "dir", "conf"]) {
    const v = searchParams[k];
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/reports/proof-forecast/export${exportParams.toString() ? `?${exportParams}` : ""}`;

  // Every active filter EXCEPT sort/dir — the sortable column headers append
  // their own, so clicking one keeps the rest of the report state intact.
  const tableParams: Record<string, string> = {};
  for (const k of ["q", "breed", "blondin", "conf"]) {
    const v = searchParams[k];
    if (v) tableParams[k] = v;
  }

  const SORTS: { code: string; label: string }[] = [
    ...(report.targetIsApril ? [] : [{ code: "certainty", label: "Confidence" }]),
    ...KEY_TRAITS.map((t) => ({ code: t.code.toLowerCase(), label: report.targetIsApril ? `${t.label} change` : `${t.label} projected` })),
    { code: "confidence", label: "Evidence" },
    { code: "name", label: "Name" },
  ];

  const bt = report.backtest;
  const lpiMove = report.movement.find((m) => m.code === "LPI");
  const confMove = report.movement.find((m) => m.code === "CONF");

  return (
    <div>
      <PageHeader
        title="Proof Forecast Report"
        subtitle={`A projected ${report.targetLabel} value for every trait, with the confidence in each — for bulls with a NAAB code. Latest round on file: ${report.latestLabel ?? "—"}.`}
        actions={<a href={exportHref} className="btn-primary">⬇ Export to Excel</a>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="NAAB bulls forecast"
          value={fmtNum(report.compared)}
          hint={report.notComparable ? `${fmtNum(report.notComparable)} lack 2+ rounds` : undefined}
          tone="good"
        />
        <StatCard
          label="Average LPI confidence"
          value={report.avgLpiConfidence != null ? `${report.avgLpiConfidence}%` : "—"}
          hint="in the projected value"
          tone={(report.avgLpiConfidence ?? 0) >= 60 ? "good" : "warn"}
        />
        <StatCard label="Key traits tracked" value={KEY_TRAITS.length} />
        <StatCard
          label="Low-confidence bulls"
          value={fmtNum(report.lowConfidence)}
          hint="LPI projection under 50%"
          tone={report.lowConfidence ? "warn" : "default"}
        />
      </div>

      <form method="get" className="card card-pad mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={report.q} placeholder="Name, NAAB, or reg…" className="input min-w-[200px]" />
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
            {SORTS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Order</label>
          <select name="dir" defaultValue={report.dir} className="input">
            <option value="desc">Highest first</option>
            <option value="asc">Lowest first</option>
          </select>
        </div>
        <div>
          <label className="label" title="How much history backs the forecast: rounds on file and reliability.">Evidence</label>
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
          <Card title="Proof forecast">
            <EmptyState message={
              report.compared === 0
                ? "No NAAB bulls have two or more proof rounds yet — a forecast needs at least two rounds of history."
                : "No bulls match the current filters. Widen the search or clear the filters."
            } />
          </Card>
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              Showing {fmtNum(report.rows.length)} of {fmtNum(report.compared)} NAAB bulls, projected to{" "}
              <strong>{report.targetLabel}</strong>
              {report.targetKind === "official" ? " (an official round)" : " (an interim round)"}. Each cell is the{" "}
              <strong>projected value</strong> with the <strong>confidence</strong> in it underneath — green is a
              projection you can lean on, red is one you cannot. Click a bull to open every trait.
              {lpiMove && confMove && (
                <> Confidence differs by trait for a real reason: Conformation changes in only{" "}
                  {Math.round(confMove.movedShare)}% of rounds, so it projects confidently; LPI changes in{" "}
                  {Math.round(lpiMove.movedShare)}% and says so.</>
              )}
              {" "}Cohort: {report.cohortLabel}.
            </p>
            <ProofForecastTable
              rows={report.rows}
              keyTraits={KEY_TRAITS}
              sort={report.sort}
              dir={report.dir}
              params={tableParams}
              basePath="/reports/proof-forecast"
              targetLabel={report.targetLabel}
              isApril={report.targetIsApril}
            />
          </>
        )}
      </div>

      {/* Kept below the table so the top of this report reads exactly like the
          other two. A projection is modelled, so it has to show its own record. */}
      {bt.ran && !report.targetIsApril && (
        <Card className="mt-4" title="How accurate is this?">
          <p className="mb-3 text-sm text-slate-600">
            The last <strong>{bt.rangeRounds} rounds</strong> were held back one at a time and re-forecast from only what
            was on file beforehand, across {fmtNum(bt.bulls)} bulls. The forecast scored{" "}
            <strong>{bt.overallRangeSkill}% better</strong> than the single lineup-wide figure this report used to
            publish. The projected value itself is the current value — which way a bull moves is not forecastable, so
            the confidence percentage is what the model actually contributes.
          </p>
          <Table head={<>
            <th className="th">Trait</th>
            <th className="th text-right">Forecasts tested</th>
            <th className="th text-right" title="Lower is better — it scores the whole forecast, penalising both misses and vagueness">Score</th>
            <th className="th text-right">Old model</th>
            <th className="th text-right">Better by</th>
            <th className="th text-right" title="Share of the tested rounds where this trait did not change at all">Didn&apos;t move</th>
          </>}>
            {bt.traits.filter((t) => t.rangeN > 0).map((t) => (
              <tr key={t.code}>
                <td className="td">{t.label}</td>
                <td className="td text-right tabular-nums text-slate-500">{fmtNum(t.rangeN)}</td>
                <td className="td text-right font-semibold tabular-nums">{t.crps}</td>
                <td className="td text-right tabular-nums text-slate-500">{t.cohortCrps}</td>
                <td className={`td text-right font-semibold tabular-nums ${t.rangeSkill > 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {t.rangeSkill > 0 ? "+" : ""}{t.rangeSkill}%
                </td>
                <td className="td text-right tabular-nums text-slate-400">{t.zeroShare}%</td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-[11px] text-slate-500">
            The last column explains the confidence figures: where a trait rarely moves, its projection is easy and
            scores high; where it moves every round, no model can pin it down and the percentage says so. April base
            changes are excluded on purpose — a rollback moves every bull at once and gets its own report.
          </p>
        </Card>
      )}
    </div>
  );
}
