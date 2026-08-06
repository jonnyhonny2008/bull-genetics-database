import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { listProofRuns } from "@/lib/proof-round-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function RoundCompareReportPage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const runs = await listProofRuns();
  // Sensible defaults: newest round as the "to", the one before it as the "from".
  const defTo = runs[0] ?? "";
  const defFrom = runs[1] ?? runs[0] ?? "";

  return (
    <div>
      <PageHeader
        title="Proof Change Report (Breed)"
        subtitle="Compare how the NAAB Holstein lineup moved between any two proof rounds — as a self-contained HTML file you can open in any browser or email."
      />

      {runs.length < 2 ? (
        <Card title="Proof Change Report">
          <p className="text-sm text-slate-600">
            At least two proof rounds must be on file to compare. Only {runs.length} round is loaded so far.
          </p>
        </Card>
      ) : (
        <Card title="Generate a comparison">
          <form action="/reports/round-compare/export" method="get" className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="label" htmlFor="type">Report</label>
                <select id="type" name="type" defaultValue="ebv" className="input min-w-[240px]">
                  <option value="ebv">EBV — daughter-proven bulls</option>
                  <option value="pa">PA — genomic bulls</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="from">From round</label>
                <select id="from" name="from" defaultValue={defFrom} className="input min-w-[180px]">
                  {runs.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="to">To round</label>
                <select id="to" name="to" defaultValue={defTo} className="input min-w-[180px]">
                  {runs.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" formTarget="_blank" className="btn-primary">Open report in a new tab</button>
              <button type="submit" name="download" value="1" className="btn-secondary">⬇ Download .html</button>
            </div>

            <p className="text-[11px] leading-relaxed text-slate-500">
              The EBV report covers the daughter-proven bulls and adds two &ldquo;newly proven&rdquo; sections at the top
              (bulls that went from genomic to their first daughter proof). The PA report covers the genomic bulls. Both
              share the breed-wide averages, the LPI and Conformation gainers/losers, and the All&nbsp;Breed /
              Top&nbsp;1,000 / Top&nbsp;200 toggle. The file is self-contained — the toggle works even when opened
              from your desktop, and it needs no login to view or email.
            </p>
          </form>
        </Card>
      )}
    </div>
  );
}
