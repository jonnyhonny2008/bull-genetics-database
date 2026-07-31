// Server-only: build the styled Excel workbook for the Proof Change Report.
// Kept out of proof-change.ts so the client table (which imports only types)
// never pulls exceljs into the browser bundle.

import ExcelJS from "exceljs";
import { KEY_TRAITS, type ProofChangeReport, type TraitChange } from "./proof-change";

const GREEN = { fill: "FFE7F6EC", font: "FF15803D" };
const RED = { fill: "FFFDE7E7", font: "FFB91C1C" };
const AMBER = "FFFFF3CD";

function paint(cell: ExcelJS.Cell, delta: number | null) {
  if (delta == null || delta === 0) return;
  const c = delta > 0 ? GREEN : RED;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.fill } };
  cell.font = { color: { argb: c.font }, bold: true };
}

/** Human-readable label for the rounds being compared, e.g. "Dec 2025 to Apr 2026". */
function windowLabel(report: ProofChangeReport): string {
  const short = (key: string) => {
    const p = report.periods.find((x) => x.key === key);
    if (!p) return key;
    const [m, y] = p.label.split(" ");
    return `${m.slice(0, 3)} ${y}`;
  };
  if (report.from && report.to) return `${short(report.from)} to ${short(report.to)}`;
  if (report.to) return `to ${short(report.to)}`;
  if (report.from) return `from ${short(report.from)}`;
  return report.mode === "consecutive" ? "latest vs previous run" : "latest vs previous official";
}

/** Report title — the interim view compares consecutive runs, not official rounds. */
function reportName(report: ProofChangeReport): string {
  return report.mode === "consecutive" ? "Interim Proof Change Report" : "Proof Change Report";
}

/**
 * Download filename: purpose first (so the files group together when sorted),
 * then the rounds compared, then the date it was generated.
 *   Proof Change Report - Dec 2025 to Apr 2026 - generated 2026-07-30.xlsx
 */
export function proofChangeFilename(report: ProofChangeReport, now: Date = new Date()): string {
  const generated = now.toISOString().slice(0, 10);
  const bits = [reportName(report), windowLabel(report), `generated ${generated}`];
  if (report.significantOnly) bits.splice(2, 0, "significant only");
  // Strip anything a filesystem or Content-Disposition header would choke on.
  return `${bits.join(" - ").replace(/[\\/:*?"<>|]/g, "-")}.xlsx`;
}

export async function buildProofChangeWorkbook(report: ProofChangeReport): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics";
  wb.created = new Date();
  wb.title = `${reportName(report)} — ${windowLabel(report)}`;
  wb.subject = "Bull proof changes between evaluation rounds";
  wb.description = `NAAB bulls compared ${windowLabel(report)}. ${report.compared} bulls; ${report.significantCount} with a key trait past ${report.sdMult} SD.`;

  // --- Sheet 1: summary (key traits, wide) ---
  const s1 = wb.addWorksheet("Proof Changes");
  // No SD columns in the export — the workbook is for reference, so it carries
  // previous / latest / change only. Flag counts still reflect the SD rule.
  const head: string[] = ["Bull", "NAAB", "Reg", "Breed", "Previous proof", "Latest proof"];
  for (const t of KEY_TRAITS) head.push(`${t.label} prev`, `${t.label} latest`, `${t.label} Δ`);
  head.push("Key traits flagged", "All traits flagged", "Other flagged traits", "What changed most");
  s1.addRow(head);
  s1.getRow(1).font = { bold: true };
  s1.getRow(1).alignment = { vertical: "middle", wrapText: true };

  for (const r of report.rows) {
    const byCode = new Map(r.change.keyChanges.map((k) => [k.code, k]));
    const cells: (string | number | null)[] = [r.name, r.naab ?? "", r.reg ?? "", r.breed ?? "", r.change.previousRun ?? "", r.change.latestRun ?? ""];
    for (const t of KEY_TRAITS) {
      const k = byCode.get(t.code);
      cells.push(k?.previous ?? null, k?.latest ?? null, k?.delta ?? null);
    }
    cells.push(r.change.keyFlaggedCount, r.change.flaggedCount, r.change.otherFlagged.map((t) => `${t.name} ${t.delta}`).join("; "), r.change.summary);
    const row = s1.addRow(cells);
    KEY_TRAITS.forEach((t, i) => {
      const k = byCode.get(t.code);
      const deltaCol = 6 + i * 3 + 3; // 6 lead cols; each trait block is prev/latest/Δ
      paint(row.getCell(deltaCol), k?.delta ?? null);
      if (k?.flagged) for (const col of [deltaCol - 2, deltaCol - 1, deltaCol]) row.getCell(col).border = { bottom: { style: "thick", color: { argb: "FFF59E0B" } } };
    });
    if (r.change.keyFlaggedCount > 0) row.getCell(6 + KEY_TRAITS.length * 3 + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
  }
  s1.columns.forEach((col, i) => { col.width = i < 6 ? 16 : 11; });
  s1.getColumn(head.length).width = 42;
  s1.getColumn(head.length - 1).width = 30;
  s1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  // --- Sheet 2: every trait change (long) ---
  const s2 = wb.addWorksheet("All trait changes");
  s2.addRow(["Bull", "NAAB", "Trait", "Category", "Key trait", "Previous", "Latest", "Change", "% change", "Flagged"]);
  s2.getRow(1).font = { bold: true };
  for (const r of report.rows) {
    for (const t of r.change.allChanges as TraitChange[]) {
      const row = s2.addRow([r.name, r.naab ?? "", t.name, t.category ?? "", t.key ? "yes" : "", t.previous, t.latest, t.delta, t.pct == null ? null : Math.round(t.pct * 100) / 100, t.flagged ? "yes" : ""]);
      paint(row.getCell(8), t.delta);
      if (t.flagged) row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
    }
  }
  s2.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 2 ? 26 : i === 3 ? 14 : 11; });
  s2.views = [{ state: "frozen", ySplit: 1 }];

  return wb;
}
