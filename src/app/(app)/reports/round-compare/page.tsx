import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { listProofRuns } from "@/lib/proof-round-report";

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
  // Sensible defaults: newest round as the "to", the one before it as the "from".
  const defTo = runs[0] ?? "";
  const defFrom = runs[1] ?? runs[0] ?? "";

  const title = isEbv
    ? "Proof Change Report — Daughter-Proven (EBV)"
    : "Proof Change Report — Genomic (PA)";
  const subtitle = isEbv
    ? "How the daughter-proven (EBV) NAAB Holstein bulls moved between any two proof rounds — as a self-contained HTML file you can open in any browser or email."
    : "How the genomic (PA) NAAB Holstein bulls moved between any two proof rounds — as a self-contained HTML file you can open in any browser or email.";

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />

      {runs.length < 2 ? (
        <Card title={title}>
          <p className="text-sm text-slate-600">
            At least two proof rounds must be on file to compare. Only {runs.length} round is loaded so far.
          </p>
        </Card>
      ) : (
        <Card title={`Generate the ${isEbv ? "EBV" : "PA"} comparison`}>
          <form action="/reports/round-compare/export" method="get" className="space-y-4">
            {/* Type is fixed by which report you opened. */}
            <input type="hidden" name="type" value={type} />
            <div className="flex flex-wrap items-end gap-4">
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
              <button type="submit" name="download" value="1" className="btn-secondary">Download .html</button>
            </div>

            <p className="text-[11px] leading-relaxed text-slate-500">
              {isEbv ? (
                <>This report covers the <strong>daughter-proven (EBV)</strong> bulls and adds two &ldquo;newly
                proven&rdquo; sections at the top — bulls that went from genomic (PA) to their first daughter proof
                between the two rounds. </>
              ) : (
                <>This report covers the <strong>genomic (PA)</strong> bulls. </>
              )}
              It shows the breed-wide average change boxes, the LPI and Conformation gainers/losers, and the full Top-100
              table, with an All&nbsp;Breed / Top&nbsp;1,000 / Top&nbsp;200 toggle. The file is self-contained — the
              toggle works even when opened from your desktop, and it needs no login to view or email.
            </p>
          </form>
        </Card>
      )}
    </div>
  );
}
