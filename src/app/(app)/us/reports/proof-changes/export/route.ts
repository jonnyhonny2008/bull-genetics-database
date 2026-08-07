import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getUsProofChangeReport } from "@/lib/us-cdcb/proof-change";
import { buildUsProofChangeWorkbook } from "@/lib/us-cdcb/proof-change-xlsx";
import { usProofChangeHtml, usProofChangeFilename } from "@/lib/us-cdcb/report-html-proof";
import { attachment } from "@/lib/report-http";

export const dynamic = "force-dynamic";
// The report reads two whole CDCB rounds — tens of thousands of rows — pairs them
// in memory and scores every trait against the cohort. Fast, but give it headroom.
export const maxDuration = 60;

/**
 * Export the US Proof Change Report: Excel by default, one self-contained
 * interactive HTML file with ?format=html.
 *
 * It takes the SAME query string the report page is on and hands it to the SAME
 * builder, so the download is the view the user is looking at — including the
 * round pair, the breed (which re-bases the comparison group, not just the row
 * list), the sensitivity and the sort.
 */
export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const report = await getUsProofChangeReport(sp);

  // Both of these are setup states the report page catches before it ever renders
  // an export button, so they are only reachable by hand-editing the URL. Say what
  // is missing rather than handing back a file with nothing in it.
  if (report.missingTables) {
    return NextResponse.json(
      { error: "The American tables have not been created yet — run `npm run db:push:prod`, then import a CDCB round." },
      { status: 409 },
    );
  }
  if (report.notEnoughRounds) {
    return NextResponse.json(
      { error: "Two official CDCB rounds are needed to compare. Monthly and weekly adds are provisional and are never read as a round." },
      { status: 409 },
    );
  }

  if (sp.format === "html") {
    return new Response(usProofChangeHtml(report), {
      headers: attachment("text/html; charset=utf-8", usProofChangeFilename(report, "html")),
    });
  }

  const wb = await buildUsProofChangeWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: attachment(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      usProofChangeFilename(report, "xlsx"),
    ),
  });
}
