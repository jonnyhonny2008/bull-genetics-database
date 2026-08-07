import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getUsRoundSummary } from "@/lib/us-cdcb/round-summary";
import { buildUsRoundSummaryWorkbook } from "@/lib/us-cdcb/round-summary-xlsx";
import { usRoundSummaryHtml, usRoundSummaryFilename } from "@/lib/us-cdcb/report-html-summary";
import { attachment } from "@/lib/report-http";

export const dynamic = "force-dynamic";
// Two full official rounds are read and joined in memory. Give it headroom.
export const maxDuration = 60;

/**
 * Export "What changed this round": Excel by default, one self-contained
 * interactive HTML file with ?format=html.
 *
 * The report takes no parameters — it is always the newest official round against
 * the one before it — so this route takes none either. The two files differ only
 * in depth: the HTML carries a deep slice of each list and states where it cut,
 * the workbook carries every comparable bull.
 */
export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const report = await getUsRoundSummary();

  // Setup states the report page catches before it renders an export button, so
  // they are only reachable by hand-editing the URL.
  if (report.missingTables) {
    return NextResponse.json(
      { error: "The American tables have not been created yet — run `npm run db:push:prod`, then import a CDCB round." },
      { status: 409 },
    );
  }
  if (!report.latestRound || !report.previousRound) {
    return NextResponse.json(
      { error: "Two official CDCB rounds are needed to summarise movement. Monthly and weekly adds are provisional and are never compared as rounds." },
      { status: 409 },
    );
  }

  if (sp.format === "html") {
    return new Response(usRoundSummaryHtml(report), {
      headers: attachment("text/html; charset=utf-8", usRoundSummaryFilename(report, "html")),
    });
  }

  const wb = await buildUsRoundSummaryWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: attachment(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      usRoundSummaryFilename(report, "xlsx"),
    ),
  });
}
