import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getMatingProgramReport } from "@/lib/mating-program";
import { buildMatingProgramWorkbook, matingProgramFilename } from "@/lib/mating-program-xlsx";
import { matingProgramHtml } from "@/lib/report-html-mating";
import { attachment } from "@/lib/report-http";

export const dynamic = "force-dynamic";
// The export re-runs the whole report, including live Lactanet lookups for any
// female not in the database, so it needs the same headroom as the page.
export const maxDuration = 300;

export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  // The workbook's Excluded sheet IS the audit trail, so it takes the complete
  // exclusion list. The web page caps that list because its copy is serialised
  // into the browser payload on every load; this one never leaves the server.
  const report = await getMatingProgramReport(sp, { fullExclusions: true });

  // ?format=html — a single self-contained interactive file, for emailing the
  // report exactly as it looks in the app. Default stays the Excel workbook.
  if (sp.format === "html") {
    const html = matingProgramHtml(report);
    const filename = matingProgramFilename(report).replace(/\.xlsx$/i, ".html");
    return new Response(html, { headers: attachment("text/html; charset=utf-8", filename) });
  }

  const wb = await buildMatingProgramWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  const filename = matingProgramFilename(report);
  return new Response(buf, {
    headers: attachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename),
  });
}
