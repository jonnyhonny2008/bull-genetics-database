// The Proof Round Comparison as a flat CSV — the full type-scoped bull table,
// one row per bull, with both rounds and the change for each of the five traits.
// Pure: no prisma, no server-only. Used by the export route.

import { ROUND_TRAITS, type RoundReport, type RoundValues } from "./proof-round-report";

/** RFC-4180-ish cell: quote when it contains a comma, quote, or newline. */
function cell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const val = (v: RoundValues | null, col: string): number | null =>
  v ? ((v[col as keyof RoundValues] as number | null) ?? null) : null;

export function roundReportCsv(r: RoundReport): string {
  const lines: string[] = [];
  // A small header block so the file is self-describing when opened cold.
  lines.push(cell(r.title));
  lines.push(`${cell("From round")},${cell(r.fromRun)}`);
  lines.push(`${cell("To round")},${cell(r.toRun)}`);
  lines.push(`${cell("Population")},${cell(`${r.fullAvailable} ${r.type === "ebv" ? "daughter-proven (EBV)" : "genomic (PA)"} NAAB Holstein bulls, ranked by ${r.fromRun} LPI`)}`);
  lines.push("");

  const head = [
    "Rank", "Name", "NAAB",
    ...ROUND_TRAITS.map((t) => `${r.fromRun} ${t.label}`),
    ...ROUND_TRAITS.map((t) => `${r.toRun} ${t.label}`),
    ...ROUND_TRAITS.map((t) => `Change ${t.label}`),
  ];
  lines.push(head.map(cell).join(","));

  for (const row of r.full) {
    const from = ROUND_TRAITS.map((t) => cell(val(row.from, t.col)));
    const to = ROUND_TRAITS.map((t) => cell(val(row.to, t.col)));
    const chg = ROUND_TRAITS.map((t) => {
      const f = val(row.from, t.col), tv = val(row.to, t.col);
      return cell(f != null && tv != null ? Math.round((tv - f) * 100) / 100 : null);
    });
    lines.push([cell(row.rank), cell(row.name), cell(row.naab ?? ""), ...from, ...to, ...chg].join(","));
  }

  return lines.join("\r\n");
}
