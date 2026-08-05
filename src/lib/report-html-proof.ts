import "server-only";

// The Proof Change and Interim Proof Change reports as self-contained
// interactive HTML files. Each takes the SAME report object its
// page and workbook use, so the numbers cannot drift; every value goes through
// esc()/the formatters in ./report-html. Both reports share the same
// lead-columns + key-trait-columns + expandable-detail shape, so they share one
// module. Mirrors src/components/ProofChangeTable.tsx.

import type { ProofChangeReport, ReportRow, TraitChange } from "./proof-change";
import { KEY_TRAITS } from "./key-traits";
import {
  esc, badge, table, section, htmlDocument, signed, num2, pct01, arrow, deltaClass,
  type Row, type Column, type Cell, type Stat,
} from "./report-html";

// ============================================================================
// Proof Change + Interim Proof Change  (both from getProofChangeReport)
// ============================================================================

/** Plain word for the flag sensitivity — staff never see the statistic behind
 *  it. The number itself lives only on the report page's Sensitivity selector. */
function sensitivityWord(sdMult: number): string {
  if (sdMult <= 0.5) return "sensitive";
  if (sdMult <= 1) return "balanced";
  return "big movers only";
}

/** Detail panel: every trait, its value each round, and the change. Key first. */
function changeDetail(changes: TraitChange[]): string {
  if (!changes.length) return `<p class="empty">No trait movement on file.</p>`;
  const rows: Row[] = changes.map((c): Row => ({
    className: c.flagged ? "flagged" : "",
    cells: [
      { html: `${esc(c.name)}${c.key ? '<span class="keytag">key</span>' : ""}`, sort: c.name },
      { html: num2(c.previous), sort: c.previous, className: "al-right mono" },
      { html: num2(c.latest), sort: c.latest, className: "al-right mono" },
      { html: `<span class="${deltaClass(c.delta)}">${arrow(c.delta)} ${signed(c.delta)}</span>`, sort: c.delta, className: "al-right" },
      { html: c.flagged ? badge("unusual mover", "warn") : "", sort: c.flagged ? 1 : 0 },
    ],
  }));
  return table({
    filterable: false,
    columns: [
      { label: "Trait", sort: "text" },
      { label: "Previous", sort: "num", align: "right" },
      { label: "Latest", sort: "num", align: "right" },
      { label: "Change", sort: "num", align: "right" },
      { label: "", sort: "none" },
    ],
    rows,
  });
}

function changeRows(report: ProofChangeReport): Row[] {
  return report.rows.map((r: ReportRow): Row => {
    const byCode = new Map(r.change.keyChanges.map((k) => [k.code, k]));
    const cells: Cell[] = [
      { html: esc(r.name), sort: r.name },
      { html: r.naab ? `<span class="mono">${esc(r.naab)}</span>` : "—", sort: r.naab ?? "" },
      { html: r.reg ? `<span class="mono">${esc(r.reg)}</span>` : "—", sort: r.reg ?? "" },
      { html: esc(r.breed ?? "—"), sort: r.breed ?? "" },
    ];
    for (const t of KEY_TRAITS) {
      const k = byCode.get(t.code);
      // Show BOTH rounds — previous → latest — so the change is read in context,
      // not just its size. The coloured change sits above the two values.
      cells.push({
        html: !k || k.delta == null
          ? "—"
          : `<div class="${deltaClass(k.delta)}">${arrow(k.delta)} ${signed(k.delta)}${k.flagged ? ' <span class="flag-dot" title="unusual mover">!</span>' : ""}</div>`
            + `<div class="roundvals" title="previous → latest">${num2(k.previous)} → ${num2(k.latest)}</div>`,
        sort: k?.delta ?? null,
        className: `al-right${k?.flagged ? " flagged-cell" : ""}`,
      });
    }
    cells.push({ html: r.change.keyFlaggedCount ? badge(String(r.change.keyFlaggedCount), "warn") : "0", sort: r.change.keyFlaggedCount, className: "al-right" });
    return { cells, detail: changeDetail(r.change.allChanges) };
  });
}

export function proofChangeHtml(report: ProofChangeReport): string {
  const interim = report.mode === "consecutive";
  const title = interim ? "Interim Proof Change Report" : "Proof Change Report";
  const window = `${report.rows[0]?.change.previousRun ?? "previous"} → ${report.rows[0]?.change.latestRun ?? "latest"}`;

  const columns: Column[] = [
    { label: "Bull", sort: "text" },
    { label: "NAAB", sort: "text" },
    { label: "Reg", sort: "text" },
    { label: "Breed", sort: "text" },
    ...KEY_TRAITS.map((t): Column => ({ label: t.label, sort: "num", align: "right" })),
    { label: "Unusual movers", sort: "num", align: "right", title: `Key traits that moved unusually far compared with the rest of the ${report.cohortLabel}` },
  ];

  const stats: Stat[] = [
    { label: "NAAB bulls compared", value: report.compared, hint: report.notComparable ? `${report.notComparable} lacked a round` : undefined },
    { label: "Unusual movers", value: report.significantCount, hint: "≥1 key trait moved unusually", tone: report.significantCount ? "warn" : "good" },
    { label: "Key traits tracked", value: KEY_TRAITS.length },
    { label: "Sensitivity", value: sensitivityWord(report.sdMult) },
  ];

  const params = [
    { label: "Window", value: window },
    { label: "Comparison", value: interim ? "each latest proof vs the run immediately before it" : "each latest proof vs the previous official (Apr / Aug / Dec)" },
    { label: "Cohort", value: report.cohortLabel },
    { label: "Breed", value: report.breed || "all" },
    { label: "Sensitivity", value: sensitivityWord(report.sdMult) },
    { label: "Search", value: report.q || "—" },
  ];

  const notices: string[] = [];
  if (report.cohortTooSmall) notices.push(`<div class="notice notice-warn">The cohort (${report.cohortN} bulls) is too small to flag any trait — flags need at least 3 comparable bulls per trait.</div>`);

  return htmlDocument({
    docTitle: `${title} — ${window}`,
    reportTitle: title,
    subtitle: interim
      ? "How each NAAB bull moved between its latest proof and the run immediately before it — interim to interim, spanning official proofs."
      : "How each NAAB bull moved between its latest proof and the previous official (April / August / December) proof.",
    params,
    generatedAt: new Date(),
    stats,
    notices,
    sections: [section(`Proof changes · ${window}`, table({ columns, rows: changeRows(report), empty: "No comparable bulls for this window." }))],
    footnotes: [
      `Each key-trait cell shows the change, then the two values it is between — previous → latest — so a move is read in context, not just by its size.`,
      `A trait is highlighted as an unusual mover when it moved much further than the rest of the ${report.cohortLabel} did on that trait. "Unusual" is relative to this group, so changing the group changes what is highlighted; the sensitivity is set on the report page.`,
      "This file is a snapshot of the rounds on file when it was generated. Proofs move.",
    ],
  });
}
