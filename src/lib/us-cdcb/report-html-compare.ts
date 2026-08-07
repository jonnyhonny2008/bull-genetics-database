import "server-only";

// ---------------------------------------------------------------------------
// The CDCB round comparison as ONE self-contained interactive HTML file.
//
// Fed the same UsRoundCompare object the page renders, so an emailed file cannot
// drift from the screen that produced it.
//
// TWO THINGS TRAVEL WITH THE FILE ON PURPOSE, because a document read six months
// later has no page around it to explain itself:
//
//   * the PER-BREED framing. Every figure is within one breed, since CDCB
//     re-bases each breed separately, and a reader who assumes otherwise will
//     compare a Jersey move to a Holstein move as if they were the same size.
//   * the MIXED-RUN-KIND warning, when the two periods are not peers. On the
//     screen it is a banner; here it is a notice at the top of the document,
//     because this is the copy that gets forwarded.
// ---------------------------------------------------------------------------

import {
  esc, table, section, htmlDocument, notice, int, deltaClass,
  type Row, type Column, type Stat,
} from "../report-html";
import type { UsRoundCompare, UsMover } from "./round-compare";
import { usExportFootnotes, safeFilePart, US_RPA_NOTE } from "./report-notes";

const signed = (v: number, dp: number) => `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;

export function usRoundCompareFilename(r: UsRoundCompare, ext: "csv" | "html"): string {
  return `cdcb-round-compare-${safeFilePart(r.from.periodKey)}-to-${safeFilePart(r.to.periodKey)}.${ext}`;
}

function traitTable(r: UsRoundCompare, breedIndex: number): string {
  const b = r.breeds[breedIndex];
  const columns: Column[] = [
    { label: "Trait", sort: "text" },
    { label: "n", sort: "num", align: "right", title: "Bulls carrying this trait in BOTH periods" },
    { label: r.from.label, sort: "num", align: "right" },
    { label: r.to.label, sort: "num", align: "right" },
    { label: "Mean move", sort: "num", align: "right" },
    { label: "SD", sort: "num", align: "right", title: "Spread of the individual moves" },
    { label: "Up", sort: "num", align: "right" },
    { label: "Down", sort: "num", align: "right" },
    { label: "Same", sort: "num", align: "right" },
  ];
  const rows: Row[] = b.traits.map((t) => ({
    cells: [
      {
        html: esc(t.label) + (t.unit ? ` <span class="muted">${esc(t.unit)}</span>` : "")
          // The badge is not decoration: without it a reader takes a positive mean
          // move on an intermediate trait as improvement, which it is not.
          + (t.intermediate ? ' <span class="flag-dot" title="Intermediate optimum — the middle of the scale is the target">OPT</span>' : ""),
        sort: t.label,
      },
      { html: int(t.n), sort: t.n, align: "right" },
      { html: t.meanFrom.toFixed(t.decimals), sort: t.meanFrom, align: "right" },
      { html: t.meanTo.toFixed(t.decimals), sort: t.meanTo, align: "right" },
      {
        html: `<span class="${t.intermediate ? "" : deltaClass(t.meanDelta)}">${signed(t.meanDelta, t.decimals)}</span>`,
        sort: t.meanDelta, align: "right",
      },
      { html: t.sdDelta.toFixed(t.decimals), sort: t.sdDelta, align: "right" },
      { html: int(t.rose), sort: t.rose, align: "right" },
      { html: int(t.fell), sort: t.fell, align: "right" },
      { html: int(t.unchanged), sort: t.unchanged, align: "right" },
    ],
  }));
  return table({ columns, rows, empty: "No trait is carried by this breed in both periods." });
}

function moverTable(rows: UsMover[], empty: string): string {
  const columns: Column[] = [
    { label: "Bull", sort: "text" },
    { label: "Breed", sort: "text" },
    { label: "Before", sort: "num", align: "right" },
    { label: "After", sort: "num", align: "right" },
    { label: "Move", sort: "num", align: "right" },
  ];
  return table({
    columns,
    rows: rows.map((m) => ({
      cells: [
        {
          html: `${esc(m.name)}${m.naabCode ? `<br><span class="muted mono">NAAB ${esc(m.naabCode)}</span>` : ""}`,
          sort: m.name,
        },
        { html: esc(m.breed ?? "—"), sort: m.breed ?? "" },
        { html: String(m.from), sort: m.from, align: "right" },
        { html: String(m.to), sort: m.to, align: "right" },
        { html: `<span class="${deltaClass(m.delta)}">${m.delta > 0 ? "+" : ""}${m.delta}</span>`, sort: m.delta, align: "right" },
      ],
    })),
    empty,
  });
}

export function usRoundCompareHtml(r: UsRoundCompare): string {
  const totalCommon = r.breeds.reduce((a, b) => a + b.common, 0);
  const totalArrived = r.breeds.reduce((a, b) => a + b.arrived, 0);
  const totalDeparted = r.breeds.reduce((a, b) => a + b.departed, 0);

  const stats: Stat[] = [
    { label: "In both periods", value: int(totalCommon), hint: "the comparable cohort" },
    { label: "Arrived", value: int(totalArrived), hint: `new in ${r.to.label}` },
    { label: "Not carried forward", value: int(totalDeparted), hint: `absent from ${r.to.label}` },
    { label: "Breeds", value: String(r.breeds.length), hint: "each on its own base" },
  ];

  const notices: string[] = [];
  if (r.mixedRunKinds) {
    notices.push(notice(`These two periods are not peers. ${r.mixedRunKinds}`, "warn"));
  }
  notices.push(notice(
    "Every figure below is within ONE breed. CDCB re-bases each breed on its own population, so a move in Jersey and a move in Holstein are not the same size and are never pooled here.",
    "info",
  ));

  const sections: string[] = r.breeds.map((b, i) =>
    section(
      `${b.breed} — ${int(b.common)} bull${b.common === 1 ? "" : "s"} in both periods`,
      traitTable(r, i),
      `${int(b.arrived)} arrived and ${int(b.departed)} were not carried forward. Neither is movement; only bulls present in both periods are compared.`,
    ),
  );

  if (r.topRisers.length) {
    sections.push(section(
      "Biggest risers on the lead index",
      moverTable(r.topRisers, "No comparable movers."),
      "Ranked by how far each moved relative to his OWN breed's spread, not by raw points.",
    ));
    sections.push(section(
      "Biggest fallers on the lead index",
      moverTable(r.topFallers, "No comparable movers."),
      "Same ranking, from the other end.",
    ));
  }

  return htmlDocument({
    docTitle: `CDCB round comparison — ${r.from.label} to ${r.to.label}`,
    reportTitle: "Round Comparison — CDCB",
    subtitle: `How the American evaluations moved between ${r.from.label} and ${r.to.label}.`,
    params: [
      { label: "From", value: `${r.from.label} — ${r.from.runKind} run, ${int(r.from.animals)} animals` },
      { label: "To", value: `${r.to.label} — ${r.to.runKind} run, ${int(r.to.animals)} animals` },
      { label: "Breeds", value: r.breeds.length ? r.breeds.map((b) => b.breed).join(", ") : "none with a common cohort" },
    ],
    generatedAt: r.generatedAt,
    stats,
    notices,
    sections,
    footnotes: usExportFootnotes([
      US_RPA_NOTE,
      "Only animals present in BOTH periods are compared. Arrivals and departures are counted separately and never as a move of zero.",
    ]),
  });
}
