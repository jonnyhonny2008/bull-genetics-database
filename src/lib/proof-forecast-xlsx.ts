// Server-only: the styled Excel workbook for the Projected Proof Report.
// Kept out of proof-forecast.ts so the client table (types only) never pulls
// exceljs into the browser bundle.

import ExcelJS from "exceljs";
import { KEY_TRAITS, type ForecastReport, type TraitForecast } from "./proof-forecast";

const GREEN = { fill: "FFE7F6EC", font: "FF15803D" };
const RED = { fill: "FFFDE7E7", font: "FFB91C1C" };

function paint(cell: ExcelJS.Cell, delta: number | null) {
  if (delta == null || delta === 0) return;
  const c = delta > 0 ? GREEN : RED;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.fill } };
  cell.font = { color: { argb: c.font }, bold: true };
}

/**
 * Download filename: purpose first so the files group when sorted, then the
 * round projected, then when it was generated.
 *   Projected Proof Report - April 2026 - generated 2026-08-03.xlsx
 */
export function proofForecastFilename(report: ForecastReport, now: Date = new Date()): string {
  const bits = ["Projected Proof Report", report.targetLabel, `generated ${now.toISOString().slice(0, 10)}`];
  if (report.blondin === "1") bits.splice(2, 0, "Blondin only");
  if (report.minConfidence) bits.splice(2, 0, `${report.minConfidence}+ confidence`);
  return `${bits.join(" - ").replace(/[\\/:*?"<>|]/g, "-")}.xlsx`;
}

export async function buildProofForecastWorkbook(report: ForecastReport): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics";
  wb.created = new Date();
  wb.title = `Projected Proof Report — ${report.targetLabel}`;
  wb.subject = "Modelled next-round proof projections";
  wb.description = `Projection of the ${report.targetLabel} round for ${report.compared} NAAB bulls, from the ${report.latestLabel ?? "latest"} round. Modelled — not a published proof.`;

  // --- Sheet 1: key traits, one row per bull ---
  const s1 = wb.addWorksheet("Projections");
  const head: string[] = ["Bull", "NAAB", "Reg", "Breed", "Rounds on file", "Reliability", "Confidence", "From round", "Projected round"];
  for (const t of KEY_TRAITS) head.push(`${t.label} now`, `${t.label} projected`, `${t.label} Δ`, `${t.label} low`, `${t.label} high`);
  head.push("What moves most", "Drivers");
  s1.addRow(head);
  s1.getRow(1).font = { bold: true };
  s1.getRow(1).alignment = { vertical: "middle", wrapText: true };

  for (const r of report.rows) {
    const f = r.forecast;
    const byCode = new Map(f.keyForecasts.map((k) => [k.code, k]));
    const cells: (string | number | null)[] = [
      r.name, r.naab ?? "", r.reg ?? "", r.breed ?? "",
      f.roundsOnFile, f.reliability != null ? Math.round(f.reliability * 100) / 100 : null,
      f.confidence, f.fromRun ?? report.latestLabel ?? "", report.targetLabel,
    ];
    for (const t of KEY_TRAITS) {
      const k = byCode.get(t.code);
      cells.push(k?.current ?? null, k?.predicted ?? null, k?.delta ?? null, k?.lo ?? null, k?.hi ?? null);
    }
    cells.push(f.summary, f.drivers.join("; "));
    const row = s1.addRow(cells);
    KEY_TRAITS.forEach((t, i) => {
      const k = byCode.get(t.code);
      paint(row.getCell(9 + i * 5 + 3), k?.delta ?? null); // 9 lead cols; 5 per trait, Δ is the 3rd
    });
  }
  s1.columns.forEach((col, i) => { col.width = i < 9 ? 15 : 11; });
  s1.getColumn(head.length - 1).width = 38;
  s1.getColumn(head.length).width = 38;
  s1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  // --- Sheet 2: the full projected profile, every trait ---
  const s2 = wb.addWorksheet("Full projected profile");
  s2.addRow(["Bull", "NAAB", "Trait", "Category", "Key trait", "Current", "Projected", "Change", "Low", "High", "Basis", "Steps used"]);
  s2.getRow(1).font = { bold: true };
  for (const r of report.rows) {
    for (const t of r.forecast.allForecasts as TraitForecast[]) {
      const row = s2.addRow([r.name, r.naab ?? "", t.name, t.category ?? "", t.key ? "yes" : "", t.current, t.predicted, t.delta, t.lo, t.hi, t.basis, t.steps]);
      paint(row.getCell(8), t.delta);
    }
  }
  s2.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 2 ? 26 : i === 3 ? 14 : 11; });
  s2.views = [{ state: "frozen", ySplit: 1 }];

  // --- Sheet 3: measured accuracy, so the numbers are never read as fact ---
  const s3 = wb.addWorksheet("Accuracy (backtest)");
  if (report.backtest.ran) {
    s3.addRow([`Held out each bull's ${report.backtest.roundLabel} round and predicted it from earlier rounds only.`]);
    s3.addRow([`${report.backtest.bulls} bulls tested. Overall skill vs assuming no change: ${report.backtest.overallSkill}%. Range coverage: ${report.backtest.overallCoverage}% (target 80%).`]);
    s3.addRow([]);
    s3.addRow(["Trait", "Bulls", "Avg error", "Error if unchanged", "Skill %", "Coverage %"]);
    s3.getRow(4).font = { bold: true };
    for (const t of report.backtest.traits) s3.addRow([t.label, t.n, t.mae, t.naiveMae, t.skill, t.coverage]);
  } else {
    s3.addRow(["Not enough bulls with three or more rounds to measure accuracy yet."]);
  }
  s3.getColumn(1).width = 30;
  s3.columns.forEach((col, i) => { if (i > 0) col.width = 18; });

  return wb;
}
