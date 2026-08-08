// Server-only: build the Excel workbook for the Proof Card (CA + US), the
// spreadsheet sibling of proof-card-pdf-ca.tsx / proof-card-pdf-us.tsx. Kept
// out of proof-card-ca.ts/proof-card-us.ts so any client component that only
// needs the data TYPES never pulls exceljs into the browser bundle — the same
// split every other *-xlsx.ts file in this app already uses (see
// mating-program-xlsx.ts, proof-change-xlsx.ts).
//
// English labels only. Locale is a PDF-only concept for this card (per this
// phase's own spec, ?locale= is ignored for format=xlsx) — a workbook is a
// working document for the stud's own office use, not the emailed hand-out
// the French PDF exists for, so proof-card-fr.ts is intentionally not
// imported here.
//
// Two sheets, same for CA and US:
//   1 Proof Card  — the figures a reader would look up first: lifetime
//                   performance, production, functional traits.
//   2 Linear/Type — the full composite + linear trait table, one row each,
//                   with the group header, descriptor pair and scale — the
//                   spreadsheet equivalent of the PDF's linear chart.
//
// Numbers are written as real numbers (not pre-formatted strings) wherever a
// single figure is involved, so the workbook is usable for further arithmetic
// in Excel, not just a printed snapshot. The one exception is the US card's
// "Proof Basis" cell (Daughter-Proven / Genomic / —), which has no numeric
// form — see ProofCardFunctionalCell's own doc comment in proof-card-shared.ts.

import ExcelJS from "exceljs";
import type { CaProofCardData } from "./proof-card-ca";
import type { UsProofCardData } from "./proof-card-us";
import type { ProofCardFunctionalCell, ProofCardLinearRow } from "./proof-card-shared";

const HEADER_FILL = "FF1F2D3A"; // NAVY, from proof-card-shared.tsx — same card, same navy
const HEADER_FONT = "FFFFFFFF";
const GREY = "FFF3F4F6";
const CALC_NOTE_FILL = "FFFFF3CD"; // amber — flags a computed-not-published figure

function headerRow(sheet: ExcelJS.Worksheet, cells: string[]) {
  const row = sheet.addRow(cells);
  row.font = { bold: true, color: { argb: HEADER_FONT } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });
  return row;
}

function sectionRow(sheet: ExcelJS.Worksheet, title: string, span: number) {
  const row = sheet.addRow([title]);
  row.font = { bold: true, color: { argb: "FF1F2D3A" } };
  sheet.mergeCells(row.number, 1, row.number, span);
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
  });
  return row;
}

/** Cell value for a functional-trait cell: a number stays a number (so Excel
 *  can sum/sort it), a string (e.g. the US "Proof Basis" indicator) passes
 *  through verbatim, null renders as an empty cell — never a fabricated 0. */
function functionalCellValue(v: number | string | null): number | string | null {
  return v;
}

function addFunctionalRows(sheet: ExcelJS.Worksheet, cells: ProofCardFunctionalCell[], calcFlag: (code: string) => boolean) {
  for (const c of cells) {
    const row = sheet.addRow([c.label, functionalCellValue(c.value)]);
    if (calcFlag(c.code)) row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CALC_NOTE_FILL } };
  }
}

function addLinearRows(sheet: ExcelJS.Worksheet, rows: ProofCardLinearRow[], calcFlag: (code: string) => boolean) {
  for (const r of rows) {
    const row = sheet.addRow([r.group ?? "", r.name, r.value, r.min, r.max, r.left, r.right, r.favourable ?? ""]);
    if (calcFlag(r.code)) row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: CALC_NOTE_FILL } };
  }
}

/** Strip characters a filesystem or Content-Disposition header would choke
 *  on — same rule proofChangeFilename/matingProgramFilename already apply. */
function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "-");
}

// ---------------------------------------------------------------------------
// CANADA
// ---------------------------------------------------------------------------

export function caProofCardFilename(data: CaProofCardData): string {
  return sanitizeFilename(`${data.name} - Proof Card.xlsx`);
}

export async function buildCaProofCardWorkbook(data: CaProofCardData): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics";
  wb.created = new Date();
  wb.title = `Proof Card — ${data.name}`;
  wb.subject = "Canadian Proof Card (Lactanet / CDN figures)";
  wb.description = `${data.name} — ${data.breed}${data.naab ? `, NAAB ${data.naab}` : ""}${data.registration ? `, Reg. ${data.registration}` : ""}. Proof round ${data.proofRun ?? "—"}.`;

  // ---- Sheet 1: Proof Card (summary figures) ------------------------------
  const s1 = wb.addWorksheet("Proof Card");
  headerRow(s1, [data.name, ""]);
  s1.addRow(["Breed", data.breed]);
  if (data.naab) s1.addRow(["NAAB", data.naab]);
  if (data.registration) s1.addRow(["Registration", data.registration]);
  s1.addRow(["Proof date / round", data.proofRun ?? "—"]);
  s1.addRow(["Daughters", data.daughters ?? "—"]);
  s1.addRow(["Herds", data.herds ?? "—"]);
  s1.addRow([]);

  sectionRow(s1, "Lifetime Performance", 2);
  s1.addRow(["Reliability", data.lifetimeReliability != null ? Math.round(data.lifetimeReliability * 100) / 100 : null]);
  s1.addRow(["GPA LPI", data.gpaLpi]);
  s1.addRow(["PRO $", data.proDollar]);
  s1.addRow([]);

  sectionRow(s1, "Production", 2);
  s1.addRow(["Reliability", data.productionReliability != null ? Math.round(data.productionReliability * 100) / 100 : null]);
  s1.addRow(["Milk (kg)", data.milk]);
  s1.addRow(["Fat (kg)", data.fat]);
  s1.addRow(["Fat (%)", data.fatPct]);
  s1.addRow(["Protein (kg)", data.prot]);
  s1.addRow(["Protein (%)", data.protPct]);
  s1.addRow([]);

  sectionRow(s1, "Functional Traits", 2);
  addFunctionalRows(s1, [...data.functionalLeft, ...data.functionalRight], () => false);

  s1.getColumn(1).width = 24;
  s1.getColumn(2).width = 20;

  // ---- Sheet 2: Linear / composite trait table ----------------------------
  const s2 = wb.addWorksheet("Linear & Composites");
  headerRow(s2, ["Group", "Trait", "Value", "Min", "Max", "Left (low end)", "Right (high end)", "Favourable end"]);
  addLinearRows(s2, data.linearRows, () => false);
  if (s2.rowCount === 1) s2.addRow(["", "No linear or composite values on this proof."]);
  s2.columns.forEach((c, i) => {
    c.width = i === 0 ? 22 : i === 1 ? 26 : i === 5 || i === 6 ? 16 : 10;
  });
  s2.views = [{ state: "frozen", ySplit: 1 }];

  return wb;
}

// ---------------------------------------------------------------------------
// UNITED STATES
// ---------------------------------------------------------------------------

export function usProofCardFilename(data: UsProofCardData): string {
  return sanitizeFilename(`${data.name} - Proof Card - American.xlsx`);
}

/** Codes carrying an in-house "(calc.)" computed figure — BSC (BWC) and
 *  Fertility Index — see UsProofCardData.bsc/fertilityIndex for the formulas
 *  and why these are computed rather than HAUSA-published. Flagged with the
 *  same amber the PDF marks with a "(calc.)" suffix, so the disclosure is
 *  visible in the workbook too, not just in the cell text. */
function isUsCalcCode(code: string): boolean {
  return code === "BSC" || code === "FI";
}

export async function buildUsProofCardWorkbook(data: UsProofCardData): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics";
  wb.created = new Date();
  wb.title = `Proof Card — ${data.name}`;
  wb.subject = "American Proof Card (CDCB / Holstein USA figures)";
  wb.description = `${data.name} — ${data.breed}${data.naab ? `, NAAB ${data.naab}` : ""}, ${data.id17}. Round ${data.proofDateLabel ?? "—"}.`;

  // ---- Sheet 1: Proof Card (summary figures) ------------------------------
  const s1 = wb.addWorksheet("Proof Card");
  headerRow(s1, [data.name, ""]);
  s1.addRow(["Breed", data.breed]);
  if (data.naab) s1.addRow(["NAAB", data.naab]);
  s1.addRow(["CDCB id17", data.id17]);
  s1.addRow(["Proof date / round", data.proofDateLabel ?? "—"]);
  s1.addRow(["Proof basis", data.proofBasisLabel]);
  s1.addRow([]);

  sectionRow(s1, "Lifetime Performance", 2);
  s1.addRow(["Reliability (%)", data.milkRel != null ? Math.round(data.milkRel) : null]);
  s1.addRow(["GTPI", data.tpi]);
  s1.addRow(["NET MERIT $", data.nmDollar]);
  s1.addRow([]);

  sectionRow(s1, "Production", 2);
  s1.addRow(["Reliability (%)", data.milkRel != null ? Math.round(data.milkRel) : null]);
  s1.addRow(["Milk (lb)", data.milk]);
  s1.addRow(["Fat (lb)", data.fat]);
  s1.addRow(["Fat (%)", data.fatPct]);
  s1.addRow(["Protein (lb)", data.pro]);
  s1.addRow(["Protein (%)", data.proPct]);
  s1.addRow([]);

  sectionRow(s1, "Functional Traits", 2);
  addFunctionalRows(s1, [...data.functionalLeft, ...data.functionalRight], isUsCalcCode);
  s1.addRow([]);

  const noteRow = s1.addRow(["Note", "Cells shaded amber (e.g. Fertility Index, BSC) are computed in-house from published HAUSA inputs — not a figure HAUSA publishes directly. See the workbook description / this app's documentation for the formulas."]);
  noteRow.font = { italic: true };
  s1.mergeCells(noteRow.number, 2, noteRow.number, 2);

  s1.getColumn(1).width = 24;
  s1.getColumn(2).width = 60;

  // ---- Sheet 2: Linear / composite trait table ----------------------------
  const s2 = wb.addWorksheet("Linear & Composites");
  headerRow(s2, ["Group", "Trait", "Value", "Min", "Max", "Left (low end)", "Right (high end)", "Favourable end"]);
  addLinearRows(s2, [...data.compositeRows, ...data.linearRows], isUsCalcCode);
  if (s2.rowCount === 1) s2.addRow(["", "No linear or composite values on this proof."]);
  s2.columns.forEach((c, i) => {
    c.width = i === 0 ? 22 : i === 1 ? 26 : i === 5 || i === 6 ? 16 : 10;
  });
  s2.views = [{ state: "frozen", ySplit: 1 }];
  const legendRow = s2.addRow([]);
  s2.addRow(["", "Rows shaded amber (BSC) are computed in-house — see the Proof Card sheet's note."]);
  s2.getRow(legendRow.number + 1).font = { italic: true };

  return wb;
}
