import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getProofForecastReport } from "@/lib/proof-forecast";
import { buildProofForecastWorkbook, proofForecastFilename } from "@/lib/proof-forecast-xlsx";
import { proofForecastHtml } from "@/lib/report-html-proof";
import { attachment } from "@/lib/report-http";

export const dynamic = "force-dynamic";
// Same model cost as the page, plus building a workbook of every trait for
// every bull. See the note on the page.
export const maxDuration = 60;

export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const report = await getProofForecastReport(sp);

  // ?format=html — one self-contained interactive file for emailing. Default is Excel.
  if (sp.format === "html") {
    const filename = proofForecastFilename(report).replace(/\.xlsx$/i, ".html");
    return new Response(proofForecastHtml(report), { headers: attachment("text/html; charset=utf-8", filename) });
  }

  const wb = await buildProofForecastWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: attachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", proofForecastFilename(report)),
  });
}
