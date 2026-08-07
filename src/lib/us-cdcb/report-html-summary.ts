import "server-only";

// ---------------------------------------------------------------------------
// "What changed this round" as ONE self-contained interactive HTML file.
//
// Built on src/lib/report-html.ts and fed the same UsRoundSummary object the page
// renders, so the exported figures cannot drift from the screen. What differs is
// only how far down each list the file goes: the page shows the head of each
// list, this file carries a deep slice and says where it was cut, and the
// workbook carries every row.
//
// GTPI is the only trait here, and GTPI is CALCULATED — see ./report-notes.ts for
// why that sentence, the Holstein Association USA trademark and the pounds line
// are inside the file rather than on the page that produced it.
// ---------------------------------------------------------------------------

import {
  esc, badge, table, section, htmlDocument, cap, int, signed, deltaClass, arrow,
  type Row, type Column, type Stat,
} from "../report-html";
import {
  isUnusualMover, LIST_LIMIT, TOP_MOVER_LIMIT,
  type Mover, type UsRoundSummary,
} from "./round-summary";
import {
  usExportFootnotes, usExportNotices, safeFilePart,
  US_GRADUATION_NOTE, US_GTPI_HOLSTEIN_ONLY,
} from "./report-notes";

/**
 * How deep each list goes in the exported file.
 *
 * Deeper than the screen — a standalone document is read without a filter box
 * next to a database — but still bounded, because this is an email attachment
 * against a limit commonly near 25 MB. `cap()` states the cut inside the file at
 * the place it bit, and points at the workbook, which is not capped.
 */
const EXPORT_TOP_LIMIT = 50;
const EXPORT_LIST_LIMIT = 250;

/** GTPI is whole: the calculation is only good to about ±3 points. */
const gtpi = (n: number) => int(Math.round(n));
const gtpiDelta = (n: number) => signed(Math.round(n));

interface MoverTableOpts {
  /** Add the SD column. Used by the notable-movers list, where it is the point. */
  showSd?: boolean;
  /** The bar, for the inline badge on lists that do not carry an SD column. */
  sdMult: number;
}

function moverTable(list: Mover[], opts: MoverTableOpts): string {
  const columns: Column[] = [
    { label: "Bull", sort: "text" },
    { label: "NAAB", sort: "text" },
    { label: "Breed", sort: "text" },
    { label: "Previous", sort: "num", align: "right", title: "Calculated GTPI in the earlier round" },
    { label: "Latest", sort: "num", align: "right", title: "Calculated GTPI in the later round" },
    { label: "GTPI Δ", sort: "num", align: "right" },
    ...(opts.showSd
      ? [{ label: "SD", sort: "num", align: "right", title: "How far this move sits from the round's own mean move" } as Column]
      : []),
  ];

  const rows: Row[] = list.map((m): Row => ({
    cells: [
      {
        // The gainers and drops lists have no SD column, so a bull who is also a
        // notable mover says so beside his name rather than only in that section.
        html: `${esc(m.name)}${!opts.showSd && isUnusualMover(m) ? ` ${badge(`moved ≥${opts.sdMult} SD`, "warn")}` : ""}`,
        sort: m.name,
      },
      { html: m.naabCode ? `<span class="mono">${esc(m.naabCode)}</span>` : "—", sort: m.naabCode ?? "" },
      { html: esc(m.evalBreed ?? "—"), sort: m.evalBreed ?? "" },
      { html: gtpi(m.previous), sort: m.previous, className: "mono" },
      { html: gtpi(m.latest), sort: m.latest, className: "mono" },
      { html: `<span class="${deltaClass(m.delta)}">${arrow(m.delta)} ${gtpiDelta(m.delta)}</span>`, sort: m.delta },
      ...(opts.showSd ? [{ html: m.z == null ? "—" : esc(m.z.toFixed(1)), sort: m.z, className: "mono" }] : []),
    ],
  }));

  return table({ columns, rows, empty: "None." });
}

/** A section whose list was cut, with the cut stated where it bit. */
function cappedSection(title: string, list: Mover[], limit: number, subtitle: string, opts: MoverTableOpts): string {
  const c = cap(list, limit, "bulls");
  const body = moverTable(c.items, opts) + (c.capped ? `<p class="note">${c.note}</p>` : "");
  return section(title, body, subtitle);
}

export function usRoundSummaryFilename(report: UsRoundSummary, ext: "xlsx" | "html", now: Date = new Date()): string {
  const window = report.previousLabel === "—"
    ? report.latestLabel
    : `${report.latestLabel} vs ${report.previousLabel}`;
  return `${safeFilePart(`US Round Summary - ${window} - generated ${now.toISOString().slice(0, 10)}`)}.${ext}`;
}

export function usRoundSummaryHtml(report: UsRoundSummary): string {
  const stats: Stat[] = [
    { label: "Bulls updated", value: int(report.updated), hint: `GTPI in ${report.latestLabel}` },
    {
      label: "Avg GTPI move",
      value: report.avg == null ? "—" : gtpiDelta(report.avg),
      tone: report.avg != null && report.avg >= 0 ? "good" : "warn",
      hint: "excludes graduating bulls",
    },
    { label: "Up / Down", value: `${int(report.up)} / ${int(report.down)}`, hint: "GTPI gained vs lost" },
    {
      label: "Moved unusually",
      value: int(report.flagged.length),
      tone: report.flagged.length ? "accent" : "default",
      hint: `≥${report.sdMult} SD from the round's mean move`,
    },
    {
      label: "Graduated",
      value: int(report.graduates.length),
      tone: report.graduates.length ? "accent" : "default",
      hint: "genomic → daughter-proven",
    },
  ];

  const params = [
    { label: "Round", value: report.latestLabel },
    { label: "Compared with", value: report.previousLabel },
    { label: "Comparison group", value: "the round's non-graduating bulls carrying a calculated GTPI in both rounds" },
    { label: "Sensitivity", value: `${report.sdMult} SD` },
    { label: "Mean move", value: report.avg == null ? "—" : `${gtpiDelta(report.avg)} GTPI` },
    { label: "Spread (SD)", value: report.sd ? int(Math.round(report.sd)) : "—" },
  ];

  const notices = [...usExportNotices()];
  if (report.missingTables) {
    notices.push(`<div class="notice notice-danger">The American tables do not exist in this database, so this file has no data in it.</div>`);
  } else if (!report.latestRound || !report.previousRound) {
    notices.push(`<div class="notice notice-warn">Two official CDCB rounds are needed to summarise movement, and fewer are on file. Monthly and weekly adds are provisional and are never compared as rounds.</div>`);
  }

  const sections: string[] = [
    cappedSection(
      "Top gainers (GTPI)",
      report.gainers,
      EXPORT_TOP_LIMIT,
      `Ordinary bulls that gained the most calculated GTPI from ${report.previousLabel} to ${report.latestLabel}. The report page shows the top ${TOP_MOVER_LIMIT} of these.`,
      { sdMult: report.sdMult },
    ),
    cappedSection(
      "Biggest drops (GTPI)",
      report.drops,
      EXPORT_TOP_LIMIT,
      `Ordinary bulls that lost the most calculated GTPI. The report page shows the top ${TOP_MOVER_LIMIT} of these.`,
      { sdMult: report.sdMult },
    ),
  ];

  if (report.flagged.length) {
    sections.push(
      cappedSection(
        `Notable movers — ${int(report.flagged.length)} bull${report.flagged.length === 1 ? "" : "s"} moved unusually on GTPI`,
        report.flagged,
        EXPORT_LIST_LIMIT,
        `Measured against how this round's own cohort moved (mean ${report.avg == null ? "—" : gtpiDelta(report.avg)}, SD ${report.sd ? int(Math.round(report.sd)) : "—"}), so the herd-wide shift sits in the mean and only the bulls that moved differently are listed. Biggest departure first; the report page shows the top ${LIST_LIMIT}.`,
        { showSd: true, sdMult: report.sdMult },
      ),
    );
  }

  if (report.graduates.length) {
    sections.push(
      cappedSection(
        `Graduating bulls — ${int(report.graduates.length)} moved from genomic to daughter-proven`,
        report.graduates,
        EXPORT_LIST_LIMIT,
        "These bulls received their first daughter-based evaluation this round. They move several times further than an ordinary bull, and that is expected rather than surprising — so they are kept out of the averages and out of the notable-movers list. Highest new GTPI first.",
        { sdMult: report.sdMult },
      ),
    );
  }

  return htmlDocument({
    docTitle: `What changed this round — ${report.latestLabel}`,
    reportTitle: "What changed this round",
    subtitle: `${report.latestLabel} (official) against ${report.previousLabel} — each bull's calculated GTPI. CDCB evaluations; PTAs in pounds.`,
    params,
    generatedAt: new Date(),
    stats,
    notices,
    sections,
    footnotes: usExportFootnotes([
      US_GTPI_HOLSTEIN_ONLY,
      US_GRADUATION_NOTE,
      `A bull is a notable mover when his GTPI change sits at least ${report.sdMult} SD from how the round's own non-graduating cohort moved. That is a statement about this round's population, not an absolute standard — a quiet round makes a smaller move unusual.`,
      "The Excel export of this report carries every bull in every list, uncapped.",
    ]),
  });
}
