import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getRoundReport, type RoundReportType } from "@/lib/proof-round-report";
import { roundReportHtml } from "@/lib/report-html-round";
import { roundReportCsv } from "@/lib/proof-round-csv";
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
  const stem = `Proof Change ${type.toUpperCase()} - ${fromRun} vs ${toRun}`.replace(/[\\/:*?"<>|]/g, "-");

  // ?format=csv — the full type-scoped table as a spreadsheet-ready CSV.
  if (sp.format === "csv") {
    // A BOM so Excel opens the UTF-8 accents (bull names) correctly.
    const csv = "﻿" + roundReportCsv(report);
    return new Response(csv, { headers: attachment("text/csv; charset=utf-8", `${stem}.csv`) });
  }

  // Otherwise the self-contained HTML: download button adds ?download=1; a plain
  // hit opens it inline.
  const html = roundReportHtml(report);
  if (sp.download === "1") {
    return new Response(html, { headers: attachment("text/html; charset=utf-8", `${stem}.html`) });
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
