import "server-only";

// ---------------------------------------------------------------------------
// The US Proof Change Report as ONE self-contained interactive HTML file.
//
// Built on src/lib/report-html.ts, which is vocabulary-agnostic: it knows about
// tables, sortable headers, expandable rows, badges and the no-network rule, and
// nothing about LPI or GTPI. Nothing in it is forked here — this module only
// decides what the American report puts in those shapes.
//
// It takes the SAME UsProofChangeReport object the page renders, so the exported
// numbers cannot drift from the screen.
//
// WHAT IS AMERICAN ABOUT IT, beyond the trait names:
//
//   * COLOUR COMES FROM `favourable`, NOT FROM THE SIGN. The Canadian builder can
//     paint by sign because every Lactanet key trait is higher-is-better. Here a
//     falling somatic cell score is an improvement and a rising one is not, so
//     painting +/- would report SCS backwards. `favourable` is null for rump
//     angle, which lands it in the neutral class — the one trait that must never
//     be green or red.
//   * THE DISCLOSURES ARE IN THE FILE. Pounds, calculated GTPI, the Holstein
//     Association USA trademark and the rump-angle caveat all render as callouts
//     above the table and again as footnotes, because this file is read as an
//     email attachment with no app around it. See ./report-notes.ts.
// ---------------------------------------------------------------------------

import {
  esc, badge, table, section, htmlDocument, arrow,
  type Row, type Column, type Cell, type Stat,
} from "../report-html";
import {
  US_CHANGE_KEY_TRAITS, US_CHANGE_TRAITS, MAX_ROWS, formatUsDelta,
  type UsProofChangeReport, type UsProofChangeRow, type UsTraitChange,
} from "./proof-change";
import { usExportFootnotes, usExportNotices, safeFilePart } from "./report-notes";

/** Plain word for the flag sensitivity — the SD multiple is an internal detail. */
function sensitivityWord(sdMult: number): string {
  if (sdMult <= 0.5) return "sensitive";
  if (sdMult <= 1) return "balanced";
  return "big movers only";
}

/** How the report was ordered, in the words the page's own selector uses. */
function sortLabel(report: UsProofChangeReport): string {
  const order = report.dir === "asc" ? "smallest first" : "biggest first";
  if (report.sort === "name") return `name, ${report.dir === "asc" ? "A–Z" : "Z–A"}`;
  if (report.sort === "flags") return `traits flagged, ${order}`;
  const t = US_CHANGE_TRAITS.find((x) => x.code.toLowerCase() === report.sort);
  return `${t?.short ?? report.sort} change, ${order}`;
}

/** How graduating bulls were listed. They are out of the statistics either way. */
function gradsLabel(report: UsProofChangeReport): string {
  return report.grads === "only" ? "graduations only" : report.grads === "hide" ? "hidden" : "shown, never flagged";
}

/** A trait value at its own precision. GTPI is whole because the calc is ±3. */
function fmtValue(c: UsTraitChange, v: number | null): string {
  return v == null ? "—" : v.toFixed(c.decimals);
}

/**
 * Which colour a change gets.
 *
 * Never the sign — see the header. `favourable` is already null for every
 * intermediate-optimum trait, so rump angle falls through to the neutral class
 * without this function having to know its name.
 */
function favourClass(c: UsTraitChange): string {
  if (c.delta == null || c.delta === 0 || c.favourable === null) return "flat";
  return c.favourable ? "up" : "down";
}

/** Detail panel: every trait diffed, not just the seven the columns lead with. */
function changeDetail(r: UsProofChangeRow): string {
  const rows: Row[] = r.change.changes.map((c): Row => ({
    className: c.flagged ? "flagged" : "",
    cells: [
      {
        html: `${esc(c.label)}${c.key ? '<span class="keytag">key</span>' : ""}${
          c.computed ? '<span class="bang" title="calculated by Blondin Sires, not published by CDCB">calc</span>' : ""
        }`,
        sort: c.label,
      },
      { html: fmtValue(c, c.previous), sort: c.previous, className: "mono" },
      { html: fmtValue(c, c.latest), sort: c.latest, className: "mono" },
      {
        html: c.delta == null ? "—" : `<span class="${favourClass(c)}">${arrow(c.delta)} ${esc(formatUsDelta(c))}</span>`,
        sort: c.delta,
      },
      { html: c.z == null ? "—" : esc(c.z.toFixed(2)), sort: c.z, className: "mono" },
      {
        // Two different statements share this column, and they must not be
        // confused: "moved unusually far" is about size, "not judged" is about
        // there being no better direction to move in at all.
        html: c.direction === "intermediate"
          ? badge("not judged", "muted")
          : c.flagged
            ? badge("unusual mover", "warn")
            : "",
        sort: c.flagged ? 1 : 0,
      },
    ],
  }));
  return table({
    filterable: false,
    columns: [
      { label: "Trait", sort: "text" },
      { label: "Previous", sort: "num", align: "right", title: "Value in the earlier round" },
      { label: "Latest", sort: "num", align: "right", title: "Value in the later round" },
      { label: "Change", sort: "num", align: "right" },
      { label: "SD", sort: "num", align: "right", title: "How far this move sits from the comparison group's own move on this trait" },
      { label: "", sort: "none" },
    ],
    rows,
  });
}

function changeRows(report: UsProofChangeReport): Row[] {
  return report.rows.map((r): Row => {
    const byCode = new Map(r.change.changes.map((c) => [c.code, c]));
    const cells: Cell[] = [
      {
        html: `${esc(r.name)}${r.graduated ? ` ${badge("graduation", "accent")}` : ""}`
          + `<span class="sub">${esc(r.change.summary)}</span>`,
        sort: r.name,
      },
      { html: r.naab ? `<span class="mono">${esc(r.naab)}</span>` : "—", sort: r.naab ?? "" },
      { html: `<span class="mono">${esc(r.id17)}</span>`, sort: r.id17 },
      { html: esc(r.breed ?? "—"), sort: r.breed ?? "" },
    ];
    for (const t of US_CHANGE_KEY_TRAITS) {
      const c = byCode.get(t.code);
      // Show BOTH rounds — previous → latest — so a move is read in context and
      // not just by its size.
      cells.push({
        html: !c || c.delta == null
          ? "—"
          : `<div class="${favourClass(c)}">${arrow(c.delta)} ${esc(formatUsDelta(c))}${
              c.flagged ? ' <span class="flag-dot" title="moved unusually far compared with the comparison group">!</span>' : ""
            }</div>`
            + `<div class="roundvals" title="previous → latest">${fmtValue(c, c.previous)} → ${fmtValue(c, c.latest)}</div>`,
        sort: c?.delta ?? null,
        className: "al-right",
        title: t.direction === "intermediate" ? `${t.label} — intermediate optimum, shown but never judged` : undefined,
      });
    }
    cells.push({
      // A graduate is expected to move, so his count is not zero — it is absent.
      html: r.graduated
        ? '<span class="muted" title="a graduating bull is held out of the statistics and never flagged">n/a</span>'
        : r.change.keyFlaggedCount
          ? badge(String(r.change.keyFlaggedCount), "warn")
          : '<span class="muted">0</span>',
      sort: r.graduated ? null : r.change.keyFlaggedCount,
      className: "al-right",
    });
    return { cells, detail: changeDetail(r) };
  });
}

/** The download name: purpose, then the rounds, then the day it was generated. */
export function usProofChangeFilename(report: UsProofChangeReport, ext: "xlsx" | "html", now: Date = new Date()): string {
  const bits = ["US Proof Change Report", `${report.fromLabel} to ${report.toLabel}`];
  if (report.breed) bits.push(report.breed);
  if (report.significantOnly) bits.push("unusual movers only");
  if (report.grads === "only") bits.push("graduations only");
  bits.push(`generated ${now.toISOString().slice(0, 10)}`);
  return `${safeFilePart(bits.join(" - "))}.${ext}`;
}

export function usProofChangeHtml(report: UsProofChangeReport): string {
  const window = `${report.fromLabel} → ${report.toLabel}`;

  const columns: Column[] = [
    { label: "Bull", sort: "text" },
    { label: "NAAB", sort: "text" },
    { label: "CDCB ID", sort: "text" },
    { label: "Breed", sort: "text" },
    ...US_CHANGE_KEY_TRAITS.map((t): Column => ({
      label: `${t.short} Δ`,
      // Rump angle is still sortable AS A COLUMN in a static file — the reader
      // can order by anything — but the report itself never ranks on it, and the
      // header says why the number carries no judgement.
      sort: "num",
      align: "right",
      title: t.direction === "intermediate"
        ? `${t.label} — intermediate optimum: the change is shown, never coloured or ranked`
        : t.label,
    })),
    {
      label: "Flags",
      sort: "num",
      align: "right",
      title: `Key traits that moved unusually far compared with ${report.cohortLabel}`,
    },
  ];

  const stats: Stat[] = [
    {
      label: "Bulls compared",
      value: report.compared,
      hint: report.notComparable ? `${report.notComparable} new in ${report.toLabel}` : undefined,
      tone: "good",
    },
    {
      label: "Unusual movers",
      value: report.significantCount,
      hint: "≥1 key trait past the bar",
      tone: report.significantCount ? "warn" : "default",
    },
    {
      label: "Graduations",
      value: report.graduationCount,
      hint: "first daughter proof — never flagged",
      tone: report.graduationCount ? "accent" : "default",
    },
    { label: "Sensitivity", value: sensitivityWord(report.sdMult), hint: `unusual vs ${report.cohortLabel}` },
  ];

  const params = [
    { label: "Compare from", value: report.fromLabel },
    { label: "Compare to", value: report.toLabel },
    { label: "Comparison group", value: report.cohortLabel },
    { label: "Breed", value: report.breed || "all breeds" },
    { label: "Sensitivity", value: `${sensitivityWord(report.sdMult)} (${report.sdMult} SD)` },
    { label: "Graduations", value: gradsLabel(report) },
    { label: "Only unusual movers", value: report.significantOnly ? "yes" : "no" },
    { label: "Search", value: report.q || "—" },
    { label: "Sorted by", value: sortLabel(report) },
  ];

  const notices = [...usExportNotices()];
  if (report.missingTables) {
    notices.push(`<div class="notice notice-danger">The American tables do not exist in this database, so this file has no data in it.</div>`);
  } else if (report.notEnoughRounds) {
    notices.push(`<div class="notice notice-warn">Fewer than two official CDCB rounds are on file, so there is nothing to compare.</div>`);
  }
  if (report.cohortTooSmall) {
    notices.push(
      `<div class="notice notice-warn">Only ${esc(report.cohortN)} non-graduating bull${report.cohortN === 1 ? "" : "s"} in ${esc(report.cohortLabel)} — at least 3 are needed to measure a spread, so nothing could be flagged and every Flags count reads 0. The changes below are still real.</div>`,
    );
  }

  const capped = report.shown > MAX_ROWS;
  const footnotes = usExportFootnotes([
    `Each key-trait cell shows the change, then the two values it sits between — previous → latest — so a move is read in context and not just by its size. Click a row for every trait that moved, with the value in each round and how far the move sat from the comparison group.`,
    `A trait is flagged as an unusual mover when it moved much further than ${report.cohortLabel} did on that same trait. "Unusual" is relative to that group by design, so filtering to one breed re-bases the mean and spread and the same bull can be flagged in one view and not another. Only the seven key traits decide whether a bull counts as an unusual mover.`,
    ...(capped
      ? [`This file carries the ${MAX_ROWS} biggest movers of ${report.shown} matching bulls. The comparison group behind every flag is the full set and is unaffected by that cap; narrow by breed or search to reach further down the list.`]
      : []),
  ]);

  return htmlDocument({
    docTitle: `US Proof Change Report — ${window}`,
    reportTitle: "US Proof Change Report",
    subtitle: `How each bull moved from ${report.fromLabel} to ${report.toLabel}. CDCB evaluations — PTAs in pounds, merit indexes in US dollars. Every round here is official.`,
    params,
    generatedAt: new Date(),
    stats,
    notices,
    sections: [
      section(
        `Proof changes · ${window}`,
        table({
          columns,
          rows: changeRows(report),
          empty: report.compared === 0
            ? `No bull has an official evaluation in both ${report.fromLabel} and ${report.toLabel}.`
            : "No bulls matched the filters this file was generated with.",
        }),
        `${report.rows.length} of ${report.shown} matching bulls${report.compared !== report.shown ? ` (${report.compared} compared in total)` : ""}. Green moved favourably, red unfavourably; a highlighted figure moved unusually far. Rump Angle is never coloured.`,
      ),
    ],
    footnotes,
  });
}
