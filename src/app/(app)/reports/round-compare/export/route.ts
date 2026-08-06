import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getRoundReport, type RoundReportType } from "@/lib/proof-round-report";
import { roundReportHtml } from "@/lib/report-html-round";
import { attachment } from "@/lib/report-http";

export const dynamic = "force-dynamic";
// One report reads two whole rounds of the NAAB Holstein lineup — a few hundred
// rows — and builds the HTML in memory. Comfortably fast, but give it headroom.
export const maxDuration = 60;

export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const type: RoundReportType = sp.type === "pa" ? "pa" : "ebv";
  const fromRun = (sp.from ?? "").trim();
  const toRun = (sp.to ?? "").trim();
  if (!fromRun || !toRun) return NextResponse.json({ error: "Both a 'from' and a 'to' round are required." }, { status: 400 });
  if (fromRun === toRun) return NextResponse.json({ error: "Pick two different rounds to compare." }, { status: 400 });

  const report = await getRoundReport({ fromRun, toRun, type });
  const html = roundReportHtml(report);

  // Download button adds ?download=1; the plain View button opens it inline.
  if (sp.download === "1") {
    const filename = `Proof Change ${type.toUpperCase()} - ${fromRun} vs ${toRun}.html`.replace(/[\\/:*?"<>|]/g, "-");
    return new Response(html, { headers: attachment("text/html; charset=utf-8", filename) });
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
