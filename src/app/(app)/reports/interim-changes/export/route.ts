import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getProofChangeReport } from "@/lib/proof-change";
import { buildProofChangeWorkbook, proofChangeFilename } from "@/lib/proof-change-xlsx";
import { proofChangeHtml } from "@/lib/report-html-proof";
import { attachment } from "@/lib/report-http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const report = await getProofChangeReport(sp, { mode: "consecutive" });

  // ?format=html — one self-contained interactive file for emailing. Default is Excel.
  if (sp.format === "html") {
    const filename = proofChangeFilename(report).replace(/\.xlsx$/i, ".html");
    return new Response(proofChangeHtml(report), { headers: attachment("text/html; charset=utf-8", filename) });
  }

  const wb = await buildProofChangeWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    headers: attachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", proofChangeFilename(report)),
  });
}
