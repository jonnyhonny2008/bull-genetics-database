import "server-only";

// The Proof Change, Interim Proof Change, and Projected Proof reports as
// self-contained interactive HTML files. Each takes the SAME report object its
// page and workbook use, so the numbers cannot drift; every value goes through
// esc()/the formatters in ./report-html. The three reports share the same
// lead-columns + key-trait-columns + expandable-detail shape, so they share one
// module. Mirrors src/components/ProofChangeTable.tsx and ProofForecastTable.tsx.

import type { ProofChangeReport, ReportRow, TraitChange } from "./proof-change";
import type { ForecastReport, ForecastRow, TraitForecast } from "./proof-forecast";
import { KEY_TRAITS } from "./key-traits";
import {
  esc, badge, table, section, htmlDocument, signed, num2, pct01, arrow, deltaClass,
  type Row, type Column, type Cell, type Stat,
} from "./report-html";

// ============================================================================
// Proof Change + Interim Proof Change  (both from getProofChangeReport)
// ============================================================================

/** Detail panel: every trait, prev → latest, Δ and z, key traits first. */
function changeDetail(changes: TraitChange[]): string {
  if (!changes.length) return `<p class="empty">No trait movement on file.</p>`;
  const rows: Row[] = changes.map((c): Row => ({
    className: c.flagged ? "flagged" : "",
    cells: [
      { html: `${esc(c.name)}${c.key ? '<span class="keytag">key</span>' : ""}`, sort: c.name },
      { html: num2(c.previous), sort: c.previous, className: "al-right mono" },
      { html: num2(c.latest), sort: c.latest, className: "al-right mono" },
      { html: `<span class="${deltaClass(c.delta)}">${arrow(c.delta)} ${signed(c.delta)}</span>`, sort: c.delta, className: "al-right" },
      { html: c.z == null ? "—" : num2(c.z), sort: c.z, className: "al-right" },
      { html: c.flagged ? badge("flagged", "warn") : "", sort: c.flagged ? 1 : 0 },
    ],
  }));
  return table({
    filterable: false,
    columns: [
      { label: "Trait", sort: "text" },
      { label: "Previous", sort: "num", align: "right" },
      { label: "Latest", sort: "num", align: "right" },
      { label: "Change", sort: "num", align: "right" },
      { label: "z", sort: "num", align: "right", title: "(Δ − cohort mean Δ) / cohort SD, per trait" },
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
      cells.push({
        html: k?.delta == null ? "—" : `<span class="${deltaClass(k.delta)}">${arrow(k.delta)} ${signed(k.delta)}</span>`,
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
    { label: "Key flags", sort: "num", align: "right", title: `Key traits that moved at least ${report.sdMult} SD from the cohort mean` },
  ];

  const stats: Stat[] = [
    { label: "NAAB bulls compared", value: report.compared, hint: report.notComparable ? `${report.notComparable} lacked a round` : undefined },
    { label: "Significant movers", value: report.significantCount, hint: "≥1 key trait flagged", tone: report.significantCount ? "warn" : "good" },
    { label: "Key traits tracked", value: KEY_TRAITS.length },
    { label: "Flag threshold", value: `${report.sdMult} SD` },
  ];

  const params = [
    { label: "Window", value: window },
    { label: "Comparison", value: interim ? "each latest proof vs the run immediately before it" : "each latest proof vs the previous official (Apr / Aug / Dec)" },
    { label: "Cohort", value: report.cohortLabel },
    { label: "Breed", value: report.breed || "all" },
    { label: "Flag threshold", value: `${report.sdMult} standard deviations` },
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
      `A trait is flagged when it moved at least ${report.sdMult} standard deviations from how the ${report.cohortLabel} moved on that trait — so "flagged" means "unusual relative to this peer group", and changing the cohort changes what is flagged.`,
      "This file is a snapshot of the rounds on file when it was generated. Proofs move.",
    ],
  });
}

// ============================================================================
// Projected Proof  (from getProofForecastReport)
// ============================================================================

function forecastDetail(forecasts: TraitForecast[]): string {
  if (!forecasts.length) return `<p class="empty">No projection available.</p>`;
  const rows: Row[] = forecasts.map((f): Row => ({
    cells: [
      { html: `${esc(f.name)}${f.key ? '<span class="keytag">key</span>' : ""}`, sort: f.name },
      { html: num2(f.current), sort: f.current, className: "al-right mono" },
      { html: f.predicted == null ? "—" : `<strong>${num2(f.predicted)}</strong>`, sort: f.predicted, className: "al-right" },
      { html: f.lo == null || f.hi == null ? "—" : `${num2(f.lo)} – ${num2(f.hi)}`, sort: f.lo, className: "al-right mono" },
      { html: pct01(f.confidence), sort: f.confidence, className: "al-right" },
      { html: esc(f.basis), sort: f.basis },
    ],
  }));
  return table({
    filterable: false,
    columns: [
      { label: "Trait", sort: "text" },
      { label: "Current", sort: "num", align: "right" },
      { label: "Projected", sort: "num", align: "right" },
      { label: "Range (10–90%)", sort: "num", align: "right" },
      { label: "Confidence", sort: "num", align: "right" },
      { label: "Basis", sort: "text" },
    ],
    rows,
  });
}

function forecastRows(report: ForecastReport): Row[] {
  return report.rows.map((r: ForecastRow): Row => {
    const byCode = new Map(r.forecast.keyForecasts.map((k) => [k.code, k]));
    const cells: Cell[] = [
      { html: esc(r.name), sort: r.name },
      { html: r.naab ? `<span class="mono">${esc(r.naab)}</span>` : "—", sort: r.naab ?? "" },
      { html: r.reg ? `<span class="mono">${esc(r.reg)}</span>` : "—", sort: r.reg ?? "" },
    ];
    for (const t of KEY_TRAITS) {
      const k = byCode.get(t.code);
      cells.push({
        html: k?.predicted == null ? "—" : num2(k.predicted),
        sort: k?.predicted ?? null,
        className: "al-right",
      });
    }
    cells.push({ html: r.forecast.confidencePct == null ? "—" : pct01(r.forecast.confidencePct), sort: r.forecast.confidencePct, className: "al-right" });
    cells.push({ html: r.forecast.exposureBand ? badge(esc(r.forecast.exposureBand), "info") : "—", sort: r.forecast.exposure ?? null, className: "al-right" });
    return { cells, detail: forecastDetail(r.forecast.allForecasts) };
  });
}

export function proofForecastHtml(report: ForecastReport): string {
  const columns: Column[] = [
    { label: "Bull", sort: "text" },
    { label: "NAAB", sort: "text" },
    { label: "Reg", sort: "text" },
    ...KEY_TRAITS.map((t): Column => ({ label: t.label, sort: "num", align: "right" })),
    { label: "Confidence", sort: "num", align: "right", title: "Mean confidence across the nine key traits" },
    { label: "Movement", sort: "num", align: "right", title: "How exposed the bull is to moving, low to high" },
  ];

  const stats: Stat[] = [
    { label: "NAAB bulls forecast", value: report.compared, hint: report.notComparable ? `${report.notComparable} too little history` : undefined },
    { label: "Avg LPI confidence", value: report.rows.length ? pct01(report.rows.reduce((s, r) => s + (r.forecast.lpiConfidence ?? 0), 0) / report.rows.length) : "—" },
    { label: "Key traits tracked", value: KEY_TRAITS.length },
    { label: "Range skill vs cohort band", value: report.backtest.overallRangeSkill == null ? "—" : `${report.backtest.overallRangeSkill > 0 ? "+" : ""}${report.backtest.overallRangeSkill}%` },
  ];

  const params = [
    { label: "Projecting", value: report.targetLabel },
    { label: "From latest on file", value: report.latestLabel ?? "—" },
    { label: "Round type", value: report.targetIsApril ? "April (base change)" : report.targetIsOfficial ? "official" : "interim" },
    { label: "Breed", value: report.breed || "all" },
  ];

  return htmlDocument({
    docTitle: `Projected Proof — ${report.targetLabel}`,
    reportTitle: "Projected Proof Report",
    subtitle: "A modelled next-round proof for every NAAB bull, trait by trait, with a range on each number and the model's own backtested accuracy.",
    params,
    generatedAt: new Date(),
    stats,
    notices: [],
    sections: [section(`Projected proofs · ${report.targetLabel}`, table({ columns, rows: forecastRows(report), empty: "No bulls with enough history to project." }))],
    footnotes: [
      "The DIRECTION of a bull's next proof is not forecastable — a published proof is already the best estimate of the next one. What is projected is HOW FAR a bull is likely to move, from bulls at the same career stage. Every projection is a range, and the projected value is the current value unless the model has a reason to move it.",
      `Backtested against real rounds: the range is ${report.backtest.overallRangeSkill == null ? "—" : `${report.backtest.overallRangeSkill}%`} better than the cohort-wide band by CRPS. A snapshot of the rounds on file when generated.`,
    ],
  });
}
