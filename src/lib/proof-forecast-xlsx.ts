// Server-only: the styled Excel workbook for the Projected Proof Report.
// Kept out of proof-forecast.ts so the client table (types only) never pulls
// exceljs into the browser bundle.

import ExcelJS from "exceljs";
import { KEY_TRAITS, type ForecastReport, type TraitForecast } from "./proof-forecast";

const GREEN = { fill: "FFE7F6EC", font: "FF15803D" };
const RED = { fill: "FFFDE7E7", font: "FFB91C1C" };

/** Sheet 1 layout: fixed leading columns, then a block of columns per trait. */
const LEAD_COLS = 10;
const PER_TRAIT = 4;

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
  const head: string[] = ["Bull", "NAAB", "Reg", "Breed", "Rounds on file", "Reliability", "Evidence", "From round", "Projected round", "Overall confidence %"];
  // Per trait: where he is, the range he could land in, how far he typically
  // moves, and the odds. The Δ column is retained because an April base change
  // genuinely does have a direction.
  for (const t of KEY_TRAITS) head.push(`${t.label} now`, `${t.label} projected`, `${t.label} confidence %`, `${t.label} Δ`);
  head.push("Summary", "Drivers");
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
      f.confidencePct != null ? Math.round(f.confidencePct * 100) : null,
    ];
    for (const t of KEY_TRAITS) {
      const k = byCode.get(t.code);
      cells.push(
        k?.current ?? null,
        k?.predicted ?? null,
        k?.confidence != null ? Math.round(k.confidence * 100) : null,
        k?.delta ?? null,
      );
    }
    cells.push(f.summary, f.drivers.join("; "));
    const row = s1.addRow(cells);
    KEY_TRAITS.forEach((t, i) => {
      const k = byCode.get(t.code);
      paint(row.getCell(LEAD_COLS + i * PER_TRAIT + 4), k?.delta ?? null); // Δ is the 4th of each trait block
    });
  }
  s1.columns.forEach((col, i) => { col.width = i < LEAD_COLS ? 15 : 11; });
  s1.getColumn(head.length - 1).width = 38;
  s1.getColumn(head.length).width = 38;
  s1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  // --- Sheet 2: the full projected profile, every trait ---
  const s2 = wb.addWorksheet("Projected profile");
  s2.addRow(["Bull", "NAAB", "Trait", "Category", "Key trait", "Current", "Projected", "Confidence %", "Change", "Low", "High", "Comparable bulls", "Basis"]);
  s2.getRow(1).font = { bold: true };
  for (const r of report.rows) {
    for (const t of r.forecast.allForecasts as TraitForecast[]) {
      const row = s2.addRow([
        r.name, r.naab ?? "", t.name, t.category ?? "", t.key ? "yes" : "",
        t.current, t.predicted,
        t.confidence != null ? Math.round(t.confidence * 100) : null,
        t.delta, t.lo, t.hi, t.neighbours, t.basis,
      ]);
      paint(row.getCell(9), t.delta);
    }
  }
  s2.columns.forEach((col, i) => { col.width = i === 0 ? 22 : i === 2 ? 26 : i === 3 ? 14 : 11; });
  s2.views = [{ state: "frozen", ySplit: 1 }];

  // --- Sheet 3: how the lineup moves, and how accurate this is ---
  const s3 = wb.addWorksheet("Accuracy and movement");
  s3.addRow([`Direction is not forecastable: the projected value equals the current value on every non-April round.`]);
  s3.addRow([`The forecast is the RANGE and the odds. What follows is how well that range does, measured against real rounds.`]);
  s3.addRow([]);
  if (report.movement.length) {
    s3.addRow([`How this lineup behaves on a ${report.targetKind} round like ${report.targetLabel}`]);
    s3.addRow(["Trait", "Bulls that move %", "Typical move", "Material move", "Rounds measured"]);
    s3.getRow(5).font = { bold: true };
    for (const m of report.movement) s3.addRow([m.label, m.movedShare, m.typicalMove, m.material, m.n]);
    s3.addRow([]);
  }
  if (report.backtest.ran) {
    s3.addRow([`Held back the last ${report.backtest.rangeRounds} rounds, one at a time, and re-forecast each from earlier rounds only.`]);
    s3.addRow([`${report.backtest.bulls} bulls tested. The range scored ${report.backtest.overallRangeSkill}% better (CRPS) than the single lineup-wide range this replaces.`]);
    s3.addRow(["Trait", "Forecasts", "Range score (CRPS)", "Old model", "Sharper by %", "Didn't move %"]);
    s3.getRow(s3.rowCount).font = { bold: true };
    for (const t of report.backtest.traits.filter((x) => x.rangeN > 0)) {
      s3.addRow([t.label, t.rangeN, t.crps, t.cohortCrps, t.rangeSkill, t.zeroShare]);
    }
  } else {
    s3.addRow(["Not enough bulls with three or more rounds to measure accuracy yet."]);
  }
  s3.getColumn(1).width = 30;
  s3.columns.forEach((col, i) => { if (i > 0) col.width = 18; });

  return wb;
}
