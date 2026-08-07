// ---------------------------------------------------------------------------
// "What changed this round" as a styled Excel workbook.
//
// The screen shows the head of each list — ten gainers, ten drops, twenty-five
// notable movers — because a page is for reading. This file is for working, so
// it carries EVERY comparable bull, and the HTML export points at it for exactly
// that reason. Sorting and filtering are the spreadsheet's job from there.
//
// One report object in, three sheets out, so nothing here recomputes a figure the
// page already shows. GTPI is the only trait in the report and GTPI is calculated
// by us, not published by CDCB — which is why the third sheet exists.
// ---------------------------------------------------------------------------

import ExcelJS from "exceljs";
import { isUnusualMover, type Mover, type UsRoundSummary } from "./round-summary";
import { usWorkbookNotes } from "./report-notes";

const GREEN = { fill: "FFE7F6EC", font: "FF15803D" };
const RED = { fill: "FFFDE7E7", font: "FFB91C1C" };
const AMBER = "FFFFF3CD";

/**
 * GTPI is higher-is-better, so here — unlike the proof-change workbook, where
 * traits differ — the sign IS the direction, and painting by it is correct.
 */
function paintDelta(cell: ExcelJS.Cell, delta: number) {
  if (delta === 0) return;
  const colour = delta > 0 ? GREEN : RED;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour.fill } };
  cell.font = { color: { argb: colour.font }, bold: true };
}

/** GTPI is reported whole — the calculation is only good to about ±3 points. */
const whole = (n: number) => Math.round(n);

function addMoverSheet(
  wb: ExcelJS.Workbook,
  name: string,
  list: Mover[],
  opts: { withSd: boolean },
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  const head = ["Bull", "NAAB", "Breed", "Previous GTPI", "Latest GTPI", "GTPI Δ"];
  if (opts.withSd) head.push("SD from round mean", "Unusual mover");
  ws.addRow(head);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle", wrapText: true };

  for (const m of list) {
    const cells: (string | number | null)[] = [
      m.name, m.naabCode ?? "", m.evalBreed ?? "", whole(m.previous), whole(m.latest), whole(m.delta),
    ];
    if (opts.withSd) {
      cells.push(m.z == null ? null : Math.round(m.z * 100) / 100, isUnusualMover(m) ? "yes" : "");
    }
    const row = ws.addRow(cells);
    paintDelta(row.getCell(6), m.delta);
    if (opts.withSd && isUnusualMover(m)) {
      row.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
    }
  }

  ws.columns.forEach((col, i) => { col.width = i === 0 ? 30 : i === 1 ? 12 : 16; });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return ws;
}

export async function buildUsRoundSummaryWorkbook(report: UsRoundSummary): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics — US (CDCB)";
  wb.created = new Date();
  wb.title = `What changed this round — ${report.latestLabel}`;
  wb.subject = "CDCB round-over-round movement in calculated GTPI";
  wb.description =
    `${report.ordinary.length} bulls carried a calculated GTPI in both ${report.previousLabel} and ` +
    `${report.latestLabel}; ${report.flagged.length} moved at least ${report.sdMult} SD from the round's own ` +
    `mean move; ${report.graduates.length} received a first daughter proof. GTPI is calculated, not published by CDCB.`;

  // Ordered as the report orders it — biggest gain first, so the sheet opens on
  // the same bulls the page opens on, with the rest of the round behind them.
  const movement = [...report.ordinary].sort((a, b) => b.delta - a.delta);
  addMoverSheet(wb, "GTPI movement", movement, { withSd: true });

  // Graduates get their own sheet rather than a column, because they are not
  // comparable to the rest: a first daughter proof moves several times further
  // than an ordinary round, and they are out of every statistic on sheet 1.
  addMoverSheet(wb, "Graduations", report.graduates, { withSd: false });

  const s3 = wb.addWorksheet("Read me");
  s3.addRow(["What changed this round — US (CDCB)"]).font = { bold: true, size: 14 };
  s3.addRow([]);
  const params: [string, string][] = [
    ["Round", report.latestLabel],
    ["Compared with", report.previousLabel],
    ["Bulls updated", String(report.updated)],
    ["Bulls comparable", String(report.ordinary.length + report.graduates.length)],
    ["Comparison group", "the round's non-graduating bulls carrying a calculated GTPI in both rounds"],
    ["Mean GTPI move", report.avg == null ? "—" : String(report.avg)],
    ["Spread (SD)", report.sd ? String(Math.round(report.sd)) : "—"],
    ["Sensitivity", `${report.sdMult} SD`],
    ["Moved unusually", String(report.flagged.length)],
    ["Graduations", String(report.graduates.length)],
    ["Sheets", "‘GTPI movement’ is every comparable non-graduating bull, uncapped. ‘Graduations’ is every first daughter proof."],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
  ];
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
