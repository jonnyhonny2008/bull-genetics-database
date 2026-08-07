// ---------------------------------------------------------------------------
// The US Proof Change Report as a styled Excel workbook.
//
// The American mirror of src/lib/proof-change-xlsx.ts, and one thing in it is
// NOT a mirror: the conditional colour.
//
// Canada can paint a delta green when it is positive, because every Lactanet key
// trait it exports is higher-is-better. That is not true here. A falling somatic
// cell score is an improvement; painting it red would report SCS backwards in a
// file that leaves the building. And rump angle has an intermediate optimum, so
// neither colour is right for it at all. So every fill below comes from the
// diff engine's own `favourable` field — which is already null for intermediate
// optima — and never from the sign of the number.
//
// Kept out of proof-change.ts so the report page, which imports only types and
// the report builder, never pulls exceljs into a bundle.
// ---------------------------------------------------------------------------

import ExcelJS from "exceljs";
import {
  US_CHANGE_KEY_TRAITS, US_CHANGE_TRAITS, MAX_ROWS,
  type UsProofChangeReport, type UsTraitChange,
} from "./proof-change";
import { usWorkbookNotes } from "./report-notes";

const GREEN = { fill: "FFE7F6EC", font: "FF15803D" };
const RED = { fill: "FFFDE7E7", font: "FFB91C1C" };
const AMBER = "FFFFF3CD";

/**
 * Colour a change cell by whether the bull moved the RIGHT way.
 *
 * `favourable` is null for an intermediate-optimum trait and for a zero move, and
 * both cases are left unpainted — an unpainted cell is the honest rendering of
 * "this moved, and no direction is better".
 */
function paint(cell: ExcelJS.Cell, c: UsTraitChange | undefined) {
  if (!c || c.delta == null || c.favourable == null) return;
  const colour = c.favourable ? GREEN : RED;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour.fill } };
  cell.font = { color: { argb: colour.font }, bold: true };
}

/** Header for a trait column. `label` already carries "(lb)" where it matters. */
function traitHeader(label: string, suffix: string): string {
  return `${label} ${suffix}`;
}

/** Trait code -> the group the catalogue files it under (index / production / …). */
const GROUP_BY_CODE = new Map(US_CHANGE_TRAITS.map((t) => [t.code, t.group]));

export async function buildUsProofChangeWorkbook(report: UsProofChangeReport): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics — US (CDCB)";
  wb.created = new Date();
  wb.title = `US Proof Change Report — ${report.fromLabel} to ${report.toLabel}`;
  wb.subject = "CDCB bull proof changes between two official rounds (PTAs in pounds)";
  wb.description =
    `${report.compared} bulls compared ${report.fromLabel} to ${report.toLabel}; ` +
    `${report.significantCount} moved a key trait past ${report.sdMult} SD of ${report.cohortLabel}; ` +
    `${report.graduationCount} graduations. PTAs in pounds. GTPI is calculated, not published by CDCB.`;

  // --- Sheet 1: the seven key traits, wide -----------------------------------
  const s1 = wb.addWorksheet("Proof Changes");
  const head: string[] = ["Bull", "NAAB", "CDCB ID", "Breed", "Graduation", "From round", "To round"];
  const LEAD = head.length;
  for (const t of US_CHANGE_KEY_TRAITS) {
    head.push(traitHeader(t.label, "prev"), traitHeader(t.label, "latest"), traitHeader(t.label, "Δ"));
  }
  head.push("Key traits flagged", "All traits flagged", "Other flagged traits", "What changed most");
  s1.addRow(head);
  s1.getRow(1).font = { bold: true };
  s1.getRow(1).alignment = { vertical: "middle", wrapText: true };

  for (const r of report.rows) {
    const byCode = new Map(r.change.changes.map((c) => [c.code, c]));
    const cells: (string | number | null)[] = [
      r.name, r.naab ?? "", r.id17, r.breed ?? "", r.graduated ? "yes" : "", report.fromLabel, report.toLabel,
    ];
    for (const t of US_CHANGE_KEY_TRAITS) {
      const c = byCode.get(t.code);
      cells.push(c?.previous ?? null, c?.latest ?? null, c?.delta ?? null);
    }
    cells.push(
      // A graduate is expected to move, so his flag count is absent rather than
      // zero — zero would read as "checked and clean".
      r.graduated ? "n/a" : r.change.keyFlaggedCount,
      r.graduated ? "n/a" : r.change.flaggedCount,
      r.change.otherFlagged.map((c) => `${c.short} ${c.delta}`).join("; "),
      r.change.summary,
    );
    const row = s1.addRow(cells);

    US_CHANGE_KEY_TRAITS.forEach((t, i) => {
      const c = byCode.get(t.code);
      const deltaCol = LEAD + i * 3 + 3; // each trait block is prev / latest / Δ
      paint(row.getCell(deltaCol), c);
      if (c?.flagged) {
        for (const col of [deltaCol - 2, deltaCol - 1, deltaCol]) {
          row.getCell(col).border = { bottom: { style: "thick", color: { argb: "FFF59E0B" } } };
        }
      }
    });
    if (!r.graduated && r.change.keyFlaggedCount > 0) {
      row.getCell(LEAD + US_CHANGE_KEY_TRAITS.length * 3 + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
    }
  }

  s1.columns.forEach((col, i) => { col.width = i < LEAD ? 16 : 12; });
  s1.getColumn(head.length).width = 42;
  s1.getColumn(head.length - 1).width = 30;
  s1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

  // --- Sheet 2: every trait diffed, long -------------------------------------
  const s2 = wb.addWorksheet("All trait changes");
  s2.addRow([
    "Bull", "NAAB", "CDCB ID", "Breed", "Trait", "Group", "Key trait", "Source",
    "Better direction", "Previous", "Latest", "Change", "SD from group", "Unusual mover",
  ]);
  s2.getRow(1).font = { bold: true };
  for (const r of report.rows) {
    for (const c of r.change.changes) {
      const row = s2.addRow([
        r.name, r.naab ?? "", r.id17, r.breed ?? "", c.label,
        GROUP_BY_CODE.get(c.code) ?? "",
        c.key ? "yes" : "",
        // Saying where the number came from matters most on the rows where it is
        // not CDCB's: GTPI, UDC and FLC are ours.
        c.computed ? "calculated by Blondin Sires" : "CDCB",
        c.direction === "intermediate" ? "intermediate optimum — not judged" : c.direction,
        c.previous, c.latest, c.delta,
        c.z, c.flagged ? "yes" : "",
      ]);
      paint(row.getCell(12), c);
      if (c.flagged) row.getCell(14).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
    }
  }
  s2.columns.forEach((col, i) => { col.width = i === 0 ? 24 : i === 4 ? 26 : i === 7 || i === 8 ? 26 : 13; });
  s2.views = [{ state: "frozen", ySplit: 1 }];

  // --- Sheet 3: the disclosures ---------------------------------------------
  // Excel has no callout bar, so the notes that must travel with the numbers get
  // a sheet of their own rather than a header row nobody widens.
  const s3 = wb.addWorksheet("Read me");
  s3.addRow(["US Proof Change Report"]).font = { bold: true, size: 14 };
  s3.addRow([]);
  const params: [string, string][] = [
    ["Compare from", report.fromLabel],
    ["Compare to", report.toLabel],
    ["Comparison group", report.cohortLabel],
    ["Breed", report.breed || "all breeds"],
    ["Sensitivity", `${report.sdMult} SD`],
    ["Graduations", report.grads === "only" ? "graduations only" : report.grads === "hide" ? "hidden" : "shown, never flagged"],
    ["Only unusual movers", report.significantOnly ? "yes" : "no"],
    ["Search", report.q || "—"],
    ["Bulls compared", String(report.compared)],
    ["Rows in this file", `${report.rows.length} of ${report.shown} matching`],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
  ];
  if (report.shown > MAX_ROWS) {
    params.push([
      "Row cap",
      `The report selects the ${MAX_ROWS} biggest movers under the chosen sort. The comparison group behind every flag is the full set and is unaffected; narrow by breed or search to reach further down the list.`,
    ]);
  }
  for (const [k, v] of params) {
    const row = s3.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  s3.addRow([]);
  for (const n of usWorkbookNotes()) {
    const row = s3.addRow([n.label, n.text]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  s3.getColumn(1).width = 22;
  s3.getColumn(2).width = 110;

  return wb;
}
