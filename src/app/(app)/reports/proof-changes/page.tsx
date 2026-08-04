import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, EmptyState, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getProofChangeReport, KEY_TRAITS, SD_LEVELS } from "@/lib/proof-change";
import { ProofChangeTable } from "@/components/ProofChangeTable";

export const dynamic = "force-dynamic";

export default async function ProofChangesReportPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const report = await getProofChangeReport(searchParams);

  // Preserve current filters/sort on the Excel export link.
  const exportParams = new URLSearchParams();
  for (const k of ["q", "breed", "significant", "blondin", "sort", "dir", "sd", "from", "to"]) {
    const v = searchParams[k];
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/reports/proof-changes/export${exportParams.toString() ? `?${exportParams}` : ""}`;

  // Every active filter EXCEPT sort/dir — the sortable column headers append
  // their own, so clicking one keeps the rest of the report state intact.
  const tableParams: Record<string, string> = {};
  for (const k of ["q", "breed", "significant", "blondin", "sd", "from", "to"]) {
    const v = searchParams[k];
    if (v) tableParams[k] = v;
  }

  const SORTS: { code: string; label: string }[] = [
    { code: "lpi", label: "LPI change" },
    ...KEY_TRAITS.filter((t) => t.code !== "LPI").map((t) => ({ code: t.code.toLowerCase(), label: `${t.label} change` })),
    { code: "flags", label: "# traits ≥10%" },
    { code: "name", label: "Name" },
  ];

  return (
    <div>
      <PageHeader
        title="Proof Change Report"
        subtitle={
          report.from || report.to
            ? `Comparing ${report.periods.find((p) => p.key === report.from)?.label ?? "each bull's previous official"} → ${report.periods.find((p) => p.key === report.to)?.label ?? "each bull's latest proof"}, for bulls with a NAAB code.`
            : "Each bull's latest proof vs the previous official (April / August / December) round, for bulls with a NAAB code."
        }
        actions={<a href={exportHref} className="btn-primary">⬇ Export to Excel</a>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="NAAB bulls compared" value={fmtNum(report.compared)} hint={report.notComparable ? `${fmtNum(report.notComparable)} lack a selected round` : undefined} tone="good" />
        <StatCard label="Significant movers" value={fmtNum(report.significantCount)} hint="≥1 key trait past the bar" tone={report.significantCount ? "warn" : "default"} />
        <StatCard label="Key traits tracked" value={KEY_TRAITS.length} />
        <StatCard label="Flag threshold" value={`${report.sdMult} SD`} hint={`vs how ${report.cohortLabel} moved`} />
      </div>

      {/* Which two rounds to compare. Defaults to each bull's latest proof vs
          the official round before it; pin either side to compare set rounds. */}
      <form method="get" className="card card-pad mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="from">Compare from</label>
          <select id="from" name="from" defaultValue={report.from} className="input min-w-[190px]">
            <option value="">Auto — previous official</option>
            {report.periods.map((p) => (
              <option key={p.key} value={p.key}>{p.label}{p.official ? " · official" : " · interim"} ({p.bulls})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="to">Compare to</label>
          <select id="to" name="to" defaultValue={report.to} className="input min-w-[190px]">
            <option value="">Auto — latest proof</option>
            {report.periods.map((p) => (
              <option key={p.key} value={p.key}>{p.label}{p.official ? " · official" : " · interim"} ({p.bulls})</option>
            ))}
          </select>
        </div>
        {/* Carry the other controls so changing rounds doesn't reset them. */}
        {report.q && <input type="hidden" name="q" value={report.q} />}
        {report.breed && <input type="hidden" name="breed" value={report.breed} />}
        <input type="hidden" name="sd" value={String(report.sdMult)} />
        <input type="hidden" name="sort" value={report.sort} />
        <input type="hidden" name="dir" value={report.dir} />
        {report.significantOnly && <input type="hidden" name="significant" value="1" />}
        {report.blondin && <input type="hidden" name="blondin" value={report.blondin} />}
        <button type="submit" className="btn-primary">Compare rounds</button>
      </form>

      <form method="get" className="card card-pad mt-3 flex flex-wrap items-end gap-3">
        {report.from && <input type="hidden" name="from" value={report.from} />}
        {report.to && <input type="hidden" name="to" value={report.to} />}
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
            <option value="desc">Biggest first</option>
            <option value="asc">Smallest first</option>
          </select>
        </div>
        <div>
          <label className="label" title={`A trait is flagged when its change is this many standard deviations from how ${report.cohortLabel} moved on that trait.`}>Sensitivity</label>
          <select name="sd" defaultValue={String(report.sdMult)} className="input">
            {SD_LEVELS.map((s) => (
              <option key={s} value={s}>{s} SD {s === 0.5 ? "(sensitive)" : s === 1 ? "(balanced)" : "(big movers)"}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Only bulls where at least one of the nine KEY traits cleared the threshold.">
          <input type="checkbox" name="significant" value="1" defaultChecked={report.significantOnly} />
          Only significant changes
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Blondin bulls are the stud's own house bulls, as opposed to the wider Lactanet population. Note: this also re-bases the SD flag — significance is measured against whichever cohort is shown.">
          <input type="checkbox" name="blondin" value="1" defaultChecked={report.blondin === "1"} />
          Blondin bulls only
        </label>
        <button type="submit" className="btn-primary">Apply</button>
        <a href="/reports/proof-changes" className="btn-secondary">Reset</a>
      </form>

      <div className="mt-4">
        {report.rows.length === 0 ? (
          <Card title="Proof changes">
            <EmptyState message={
              report.compared === 0
                ? "No NAAB bulls have both a latest proof and an earlier official (April/August/December) proof to compare yet."
                : "No bulls match the current filters. Widen the search or clear the filters."
            } />
          </Card>
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              Showing {fmtNum(report.rows.length)} of {fmtNum(report.compared)} NAAB bulls. Green = increase, red = decrease.
              A trait is flagged when its change is <strong>{report.sdMult} SD or more</strong> from how <strong>{report.cohortLabel}</strong> moved
              on that trait — so it catches bulls that moved unusually, not everyone in a base shift. Only the nine key traits decide
              &ldquo;significant&rdquo;; other flagged traits still show when you expand a bull.
              {report.blondin && (
                <> The &ldquo;Blondin bulls only&rdquo; toggle changes that baseline as well as the rows, so a bull can be
                flagged here and not on the full lineup (or the reverse) — the flag always means &ldquo;unusual for {report.cohortLabel}&rdquo;.</>
              )}
            </p>
            {report.cohortTooSmall && (
              <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                Only {fmtNum(report.cohortN)} comparable bull{report.cohortN === 1 ? "" : "s"} in {report.cohortLabel} — at least 3 are
                needed to measure a spread, so no trait can be flagged and every Flags count reads 0. The changes below are still real.
              </p>
            )}
            <ProofChangeTable
              rows={report.rows}
              keyTraits={KEY_TRAITS}
              sort={report.sort}
              dir={report.dir}
              params={tableParams}
              basePath="/reports/proof-changes"
              cohortLabel={report.cohortLabel}
            />
          </>
        )}
      </div>
    </div>
  );
}
