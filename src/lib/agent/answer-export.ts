// ---------------------------------------------------------------------------
// Turning an agent answer into a downloadable report.
//
// Pure functions only (no DOM) so they can be unit-tested. The component wires
// these to Blob downloads and a print window. A "report" is the question, the
// clean answer, the tools/records the agent used, and any charts it drew.
// ---------------------------------------------------------------------------

export interface ReportData {
  question?: string;
  answer: string;
  tools?: { name: string; summary: string }[];
  records?: { tool: string; records: unknown }[];
  charts?: unknown[];
}

/** URL/file-safe slug for a report filename. */
export function slugify(s: string, max = 48): string {
  const out = (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return out || "genetics-report";
}

/** Flatten heterogeneous tool records into rows for a CSV, tagged by tool. */
export function recordsToRows(records: { tool: string; records: unknown }[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const r of records ?? []) {
    const data = r.records;
    if (Array.isArray(data)) {
      for (const item of data) {
        rows.push(item && typeof item === "object" ? { source: r.tool, ...(item as Record<string, unknown>) } : { source: r.tool, value: item });
      }
    } else if (data && typeof data === "object") {
      rows.push({ source: r.tool, ...(data as Record<string, unknown>) });
    } else if (data != null) {
      rows.push({ source: r.tool, value: data });
    }
  }
  return rows;
}

const cell = (v: unknown): string => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Rows → CSV with a header row (union of keys), RFC-4180 quoting. */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  const esc = (v: unknown) => { const s = cell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((row) => cols.map((c) => esc(row[c])).join(","))].join("\n");
}

/** A clean Markdown report: question, answer, sources, chart data, records. */
export function reportMarkdown(r: ReportData): string {
  const out: string[] = ["# Genetics report", ""];
  if (r.question) out.push(`Question: ${r.question}`, "");
  out.push(r.answer.trim(), "");
  if (r.tools?.length) {
    out.push("## Sources", "");
    for (const t of r.tools) out.push(`- ${t.name}: ${t.summary}`);
    out.push("");
  }
  if (r.charts?.length) out.push("## Charts (data)", "", "```json", JSON.stringify(r.charts, null, 2), "```", "");
  if (r.records?.length) out.push("## Records", "", "```json", JSON.stringify(r.records, null, 2), "```", "");
  return out.join("\n").trim() + "\n";
}
