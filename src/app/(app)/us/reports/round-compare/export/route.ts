import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getUsRoundCompare, type UsRoundCompare } from "@/lib/us-cdcb/round-compare";
import { usRoundCompareHtml } from "@/lib/us-cdcb/report-html-compare";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** RFC 4180 quoting: a field containing a comma, quote or newline must be quoted. */
function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(r: UsRoundCompare): string {
  const rows: string[][] = [];
  rows.push(["CDCB round comparison"]);
  rows.push(["From", `${r.from.label} (${r.from.periodKey}, ${r.from.runKind})`]);
  rows.push(["To", `${r.to.label} (${r.to.periodKey}, ${r.to.runKind})`]);
  // The mixed-run-kind caveat travels with the DATA, not just the screen — a
  // spreadsheet emailed onward otherwise loses the one thing that makes it
  // readable correctly.
  if (r.mixedRunKinds) rows.push(["WARNING", r.mixedRunKinds]);
  rows.push([]);
  rows.push(["Breed", "Trait", "Unit", "n", "Mean before", "Mean after", "Mean move", "SD of move", "Up", "Down", "Same", "Intermediate optimum"]);
  for (const b of r.breeds) {
    for (const t of b.traits) {
      rows.push([
        b.breed, t.label, t.unit ?? "", String(t.n),
        t.meanFrom.toFixed(t.decimals), t.meanTo.toFixed(t.decimals),
        t.meanDelta.toFixed(t.decimals), t.sdDelta.toFixed(t.decimals),
        String(t.rose), String(t.fell), String(t.unchanged),
        t.intermediate ? "yes" : "no",
      ]);
    }
  }
  rows.push([]);
  rows.push(["Breed cohort sizes"]);
  rows.push(["Breed", "In both periods", "Arrived", "Departed"]);
  for (const b of r.breeds) rows.push([b.breed, String(b.common), String(b.arrived), String(b.departed)]);
  rows.push([]);
  rows.push(["Biggest movers on the lead index (ranked within their own breed)"]);
  rows.push(["Direction", "Bull", "id17", "NAAB", "Breed", "Before", "After", "Move"]);
  for (const [dir, list] of [["riser", r.topRisers], ["faller", r.topFallers]] as const) {
    for (const m of list) {
      rows.push([dir, m.name, m.id17, m.naabCode ?? "", m.breed ?? "", String(m.from), String(m.to), String(m.delta)]);
    }
  }
  return rows.map((r2) => r2.map(csvCell).join(",")).join("\r\n");
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!can(user?.role, "compare:read")) return new NextResponse("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const breed = (url.searchParams.get("breed") ?? "").toUpperCase() || undefined;
  const format = url.searchParams.get("format");

  const report = await getUsRoundCompare({ from, to, breed });
  if (!report) return new NextResponse("Pick two different CDCB periods that are both on file.", { status: 400 });

  const stamp = `${report.from.periodKey}-to-${report.to.periodKey}${breed ? `-${breed}` : ""}`;

  if (format === "csv") {
    return new NextResponse(toCsv(report), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="cdcb-round-compare-${stamp}.csv"`,
      },
    });
  }

  const download = url.searchParams.get("download") === "1";
  return new NextResponse(usRoundCompareHtml(report), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(download
        ? { "content-disposition": `attachment; filename="cdcb-round-compare-${stamp}.html"` }
        : {}),
    },
  });
}
