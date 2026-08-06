import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, EmptyState } from "@/components/ui";
import { getRoundReport, listProofRuns } from "@/lib/proof-round-report";
import { RoundReportView } from "@/components/RoundReportView";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function RoundCompareReportPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  // Each Reports-page card links here with a fixed type, so the EBV and PA
  // reports are distinct entries in GenetiBase rather than one dropdown.
  const type: "ebv" | "pa" = searchParams.type === "pa" ? "pa" : "ebv";
  const isEbv = type === "ebv";

  const runs = await listProofRuns();
  const from = runs.includes(searchParams.from ?? "") ? searchParams.from! : (runs[1] ?? runs[0] ?? "");
  const to = runs.includes(searchParams.to ?? "") ? searchParams.to! : (runs[0] ?? "");

  const title = isEbv ? "Proof Change Report — Daughter-Proven (EBV)" : "Proof Change Report — Genomic (PA)";
  const subtitle = `How the ${isEbv ? "daughter-proven (EBV)" : "genomic (PA)"} NAAB Holstein bulls moved between two proof rounds. Compare any two rounds on file; download as CSV or a self-contained HTML file.`;

  const enough = runs.length >= 2 && from && to;
  const report = enough && from !== to ? await getRoundReport({ fromRun: from, toRun: to, type }) : null;

  const base = `/reports/round-compare/export?type=${type}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const csvHref = `${base}&format=csv`;
  const htmlHref = `${base}&download=1`;

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          report ? (
            <div className="flex gap-2">
              <a href={csvHref} className="btn-primary">⬇ CSV</a>
              <a href={htmlHref} className="btn-secondary" title="A single self-contained file you can email — opens in any browser, no login needed">⬇ HTML</a>
            </div>
          ) : undefined
        }
      />

      {/* Which two rounds to compare. Every round on file, interim or official. */}
      <form method="get" className="card card-pad flex flex-wrap items-end gap-3">
        <input type="hidden" name="type" value={type} />
        <div>
          <label className="label" htmlFor="from">From round</label>
          <select id="from" name="from" defaultValue={from} className="input min-w-[180px]">
            {runs.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="to">To round</label>
          <select id="to" name="to" defaultValue={to} className="input min-w-[180px]">
            {runs.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button type="submit" className="btn-primary">Compare rounds</button>
      </form>

      <div className="mt-4">
        {runs.length < 2 ? (
          <Card title={title}>
            <EmptyState message={`At least two proof rounds must be on file to compare — only ${runs.length} is loaded so far.`} />
          </Card>
        ) : from === to ? (
          <Card title={title}>
            <EmptyState message="Pick two different rounds to compare." />
          </Card>
        ) : report && report.universe === 0 ? (
          <Card title={title}>
            <EmptyState message={`No NAAB Holstein bulls were found in ${from} or ${to}.`} />
          </Card>
        ) : report ? (
          <RoundReportView report={report} />
        ) : null}
      </div>
    </div>
  );
}
