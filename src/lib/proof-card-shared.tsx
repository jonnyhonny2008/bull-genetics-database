// ---------------------------------------------------------------------------
// Proof Card — shared PDF foundation (react-pdf).
//
// One navy palette, one page-aspect constant, and a set of reusable react-pdf
// primitives shared by every country/language variant of the Proof Card
// (Canadian English this phase; American + French labels are a later phase
// built ON TOP of this file — nothing here may assume "Canadian" beyond the
// generic shapes below).
//
// Colors are lifted from this app's existing report stylesheet
// (src/lib/report-html.ts STYLESHEET, the --navy-* CSS variables used for
// every other exported report's header band) so the PDF card matches the
// rest of the app rather than inventing a second palette.
// ---------------------------------------------------------------------------

import { Fragment, type ReactNode } from "react";
import { Document, Page, View, Text, Svg, Rect, Line, StyleSheet } from "@react-pdf/renderer";

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------

/**
 * Reference template is a portrait card, 651 x 863 PIXELS (width x height).
 * This is the single source of truth for that ratio — CA and US pages must
 * both import PROOF_CARD_ASPECT (or PT_WIDTH/PT_HEIGHT below) rather than
 * hardcoding their own page size, so the two can never silently drift apart.
 */
export const PROOF_CARD_ASPECT = 651 / 863; // width / height

// react-pdf page sizes are in points. Using the reference image's pixel
// dimensions AS the point dimensions (scale factor 1) reproduces the ratio
// exactly with no rounding — simpler and safer than picking an arbitrary
// scaled multiple that has to be re-verified by hand.
export const PT_WIDTH = 651;
export const PT_HEIGHT = 863;

// ---------------------------------------------------------------------------
// Color palette — ONE navy theme for every variant (CA/US, English/French).
// Do not add a second theme; a later phase must be able to import these
// constants unchanged.
// ---------------------------------------------------------------------------

/** Primary navy — src/lib/report-html.ts's --navy-900 (the darkest stop in
 *  that file's header gradient; closest match to the reference card's navy). */
export const NAVY = "#1f2d3a";
/** Secondary navy — src/lib/report-html.ts's --navy-700 (gradient partner / mid-tone bands). */
export const NAVY_LIGHT = "#2c3e50";
/** Muted navy-grey border/rule color — --navy-200. */
export const NAVY_BORDER = "#c8ced5";
/** Pale navy tint for header sub-text (e.g. "Rel 61%" badge outline) — --navy-300. */
export const NAVY_MUTED = "#9aa5b1";

/** Favourable linear-bar color: dark navy (matches the CA reference card exactly —
 *  NOT the app's brand teal, deliberately, per this phase's instructions). */
export const BAR_FAVOURABLE = NAVY;
/** Unfavourable linear-bar color: a pale/light blue. */
export const BAR_UNFAVOURABLE = "#a9c6e0";
/** Intermediate-optimum linear-bar color: neutral grey (matches LinearGraph.tsx's
 *  bg-slate-400 "opt" bars in spirit — neither end is the target). */
export const BAR_INTERMEDIATE = "#94a3b8";

export const WHITE = "#ffffff";
export const ROW_STRIPE = "#f1f5f9"; // light grey — alternating table rows
export const TEXT_DARK = "#1e293b"; // slate-800, body text on white/light backgrounds

// ---------------------------------------------------------------------------
// Shared trait-row shape for the linear chart. CA/US data layers each export
// their own (richer) row type that is structurally assignable to this one.
// ---------------------------------------------------------------------------

export interface ProofCardLinearRow {
  code: string;
  name: string;
  /** Section this row belongs to, e.g. "Mammary System". Optional — when two
   *  consecutive rows have different groups, LinearChartTable draws a slim
   *  group-divider row between them; omit entirely to render a flat list. */
  group?: string | null;
  value: number;
  min: number;
  max: number;
  left: string;
  right: string;
  /** Which end is the better animal. Undefined = unconfigured, shaded by sign only. */
  favourable?: "left" | "right" | "intermediate";
}

export interface ProofCardFunctionalCell {
  code: string;
  label: string;
  /**
   * A number renders signed ("+12"/"−4"); a string (e.g. the US card's
   * "Daughter-Proven"/"Genomic" Proof Basis indicator, which has no numeric
   * form in this schema) renders verbatim, no sign applied. null renders "—".
   */
  value: number | string | null;
}

export interface ProofCardFigure {
  label: string;
  value: string; // pre-formatted — the shared component does not know a trait's number format
}

export interface ProofCardProductionRow {
  label: string;
  value: string; // pre-formatted primary figure, e.g. "-1,763 kg"
  secondary?: string; // pre-formatted secondary figure, e.g. "-0.16%"
}

// ---------------------------------------------------------------------------
// react-pdf stylesheet
// ---------------------------------------------------------------------------

export const styles = StyleSheet.create({
  // NOTE: physical page size is set on <Page size={[PT_WIDTH, PT_HEIGHT]}>,
  // not here — react-pdf ignores width/height in the page's own style.
  page: {
    fontFamily: "Helvetica",
    fontSize: 8,
    color: TEXT_DARK,
    backgroundColor: WHITE,
  },

  // --- header band ---
  headerBand: {
    backgroundColor: NAVY,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: "column",
    alignItems: "center",
  },
  headerFlagRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  headerFlag: { fontSize: 12, marginRight: 5 },
  headerCountry: {
    fontSize: 9,
    color: WHITE,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: WHITE,
    textAlign: "center",
    letterSpacing: 0.5,
  },

  // --- generic box chrome (Lifetime / Functional / Production) ---
  boxOuter: {
    borderWidth: 1,
    borderColor: NAVY_BORDER,
    flexDirection: "column",
  },
  boxHeader: {
    backgroundColor: NAVY,
    paddingVertical: 4,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  boxHeaderTitle: {
    fontSize: 8.5,
    fontWeight: 700,
    color: WHITE,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  relBadge: {
    borderWidth: 0.75,
    borderColor: WHITE,
    borderRadius: 3,
    paddingVertical: 1,
    paddingHorizontal: 4,
  },
  relBadgeText: { fontSize: 6.5, color: WHITE, fontWeight: 700 },

  // --- two-box row layout ---
  twoBoxRow: { flexDirection: "row" },

  // --- lifetime performance box ---
  lifetimeBody: { padding: 8, flexDirection: "column", justifyContent: "center", flexGrow: 1 },
  lifetimeFigureBlock: { marginVertical: 7 },
  lifetimeFigureLabel: { fontSize: 7, color: NAVY, textTransform: "uppercase", letterSpacing: 0.5 },
  lifetimeFigureValue: { fontSize: 20, fontWeight: 700, color: TEXT_DARK },

  // --- functional traits box ---
  functionalBody: { flexDirection: "row", padding: 4 },
  functionalCol: { flex: 1, flexDirection: "column" },
  functionalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 5,
  },
  functionalLabel: { fontSize: 7, color: TEXT_DARK, maxWidth: "72%" },
  functionalValue: { fontSize: 8, fontWeight: 700, color: NAVY },

  // --- production box ---
  productionBody: { flexDirection: "column", padding: 4 },
  productionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  productionLabel: { fontSize: 8, fontWeight: 700, color: NAVY, width: "30%" },
  productionValue: { fontSize: 10, fontWeight: 700, color: TEXT_DARK, width: "40%", textAlign: "right" },
  productionSecondary: { fontSize: 8, color: NAVY, width: "30%", textAlign: "right" },

  // --- linear chart table ---
  linearOuter: { borderWidth: 1, borderColor: NAVY_BORDER },
  linearStrip: {
    backgroundColor: NAVY,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 3,
    paddingHorizontal: 6,
  },
  linearStripText: { fontSize: 6.5, color: WHITE },
  linearGroupDivider: {
    backgroundColor: ROW_STRIPE,
    paddingVertical: 0.75,
    paddingHorizontal: 6,
    borderTopWidth: 0.5,
    borderBottomWidth: 0.5,
    borderColor: NAVY_BORDER,
  },
  linearGroupDividerText: { fontSize: 6, fontWeight: 700, color: NAVY, textTransform: "uppercase", letterSpacing: 0.5 },
  // Row height is CONTENT-bound, not this minHeight — linearNameCell always
  // stacks two lines of text (name + value), which is the real per-row cost.
  // Kept low deliberately so the floor never binds; see linearNameCell's own
  // paddingVertical for the number that actually matters. Tuned empirically
  // (measured via the PDF's own /Kids page count, not eyeballed) against the
  // real worst case: Canada's 31 rows (26 seeded linear + 5 composite index
  // rows added this session) must fit on ONE page — the locked aspect ratio
  // has no room for a silent second page.
  linearRow: { flexDirection: "row", alignItems: "stretch", minHeight: 10 },
  linearNameCell: {
    backgroundColor: NAVY,
    width: "20%",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 0.5,
  },
  linearNameText: { fontSize: 5.75, fontWeight: 700, color: WHITE },
  linearValueText: { fontSize: 5.75, fontWeight: 700, color: WHITE },
  linearDescLeftCell: {
    backgroundColor: ROW_STRIPE,
    width: "10%",
    justifyContent: "center",
    alignItems: "flex-end",
    paddingHorizontal: 3,
  },
  linearDescRightCell: {
    width: "10%",
    justifyContent: "center",
    alignItems: "flex-start",
    paddingHorizontal: 3,
  },
  linearDescText: { fontSize: 6, color: NAVY },
  linearBarCell: {
    width: "60%",
    justifyContent: "center",
    backgroundColor: WHITE,
    paddingHorizontal: 4,
  },
  linearAxisRow: { flexDirection: "row", alignItems: "center", minHeight: 12 },
  linearAxisSpacer: { width: "20%" },
  linearAxisSpacerLeft: { width: "10%" },
  linearAxisSpacerRight: { width: "10%" },
  linearAxisTicks: { width: "60%", flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 },
  linearAxisTickText: { fontSize: 5.5, color: NAVY_MUTED },
});

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Top-of-card header: flag emoji + country name + big bold centered title, navy/white. */
export function HeaderBand({ flag, country, title }: { flag: string; country: string; title: string }) {
  return (
    <View style={styles.headerBand}>
      <View style={styles.headerFlagRow}>
        <Text style={styles.headerFlag}>{flag}</Text>
        <Text style={styles.headerCountry}>{country}</Text>
      </View>
      <Text style={styles.headerTitle}>{title}</Text>
    </View>
  );
}

/** Small "Rel XX%" badge, used top-right of a box header. `percent` is 0-100, already rounded. */
export function RelBadge({ percent }: { percent: number | null }) {
  if (percent == null) return null;
  return (
    <View style={styles.relBadge}>
      <Text style={styles.relBadgeText}>Rel {percent}%</Text>
    </View>
  );
}

/** Navy header bar shared by every box (Lifetime / Functional / Production). */
export function BoxHeader({ title, badge }: { title: string; badge?: ReactNode }) {
  return (
    <View style={styles.boxHeader}>
      <Text style={styles.boxHeaderTitle}>{title}</Text>
      {badge ?? null}
    </View>
  );
}

/**
 * Generic 40/60 side-by-side layout for the card's second section. Each side
 * is a fully-built box (header + body) passed in as children — this component
 * only owns the widths and the gap, so it works unmodified for CA's
 * Lifetime/Functional pairing and any future pairing that keeps the 40/60 split.
 */
export function TwoBoxRow({
  left,
  right,
  leftWidthPct = 40,
}: {
  left: ReactNode;
  right: ReactNode;
  leftWidthPct?: number;
}) {
  return (
    <View style={styles.twoBoxRow}>
      <View style={[styles.boxOuter, { width: `${leftWidthPct}%`, borderRightWidth: 0 }]}>{left}</View>
      <View style={[styles.boxOuter, { width: `${100 - leftWidthPct}%` }]}>{right}</View>
    </View>
  );
}

/**
 * "Lifetime Performance"-style box: navy header + Rel badge, body = 2 big bold
 * stacked figures. Reused verbatim for CA (GPA LPI / PRO$) and US (GTPI / NET
 * MERIT) — only the title/figures/reliability differ per country.
 */
export function LifetimeBox({
  title,
  relPercent,
  figures,
}: {
  title: string;
  relPercent: number | null;
  figures: ProofCardFigure[];
}) {
  return (
    <View style={{ flexDirection: "column", flexGrow: 1 }}>
      <BoxHeader title={title} badge={<RelBadge percent={relPercent} />} />
      <View style={styles.lifetimeBody}>
        {figures.map((f) => (
          <View key={f.label} style={styles.lifetimeFigureBlock}>
            <Text style={styles.lifetimeFigureLabel}>{f.label}</Text>
            <Text style={styles.lifetimeFigureValue}>{f.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** "Functional Traits" box: navy header, body = 2-column grid, 6 rows per column. */
export function FunctionalTraitsBox({
  title,
  left,
  right,
}: {
  title: string;
  left: ProofCardFunctionalCell[];
  right: ProofCardFunctionalCell[];
}) {
  const fmt = (v: number | string | null) => (v == null ? "—" : typeof v === "string" ? v : v > 0 ? `+${v}` : `${v}`);
  return (
    <View style={{ flexDirection: "column", flexGrow: 1 }}>
      <BoxHeader title={title} />
      <View style={styles.functionalBody}>
        {[left, right].map((col, i) => (
          <View key={i} style={styles.functionalCol}>
            {col.map((c) => (
              <View key={c.code} style={styles.functionalRow}>
                <Text style={styles.functionalLabel}>{c.label}</Text>
                <Text style={styles.functionalValue}>{fmt(c.value)}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

/** "Production" box: navy header + Rel badge, body = one row per trait (Milk/Fat/Protein). */
export function ProductionBox({
  title,
  relPercent,
  rows,
}: {
  title: string;
  relPercent: number | null;
  rows: ProofCardProductionRow[];
}) {
  return (
    <View style={styles.boxOuter}>
      <BoxHeader title={title} badge={<RelBadge percent={relPercent} />} />
      <View style={styles.productionBody}>
        {rows.map((r, i) => (
          <View
            key={r.label}
            style={[styles.productionRow, i % 2 === 1 ? { backgroundColor: ROW_STRIPE } : {}]}
          >
            <Text style={styles.productionLabel}>{r.label}</Text>
            <Text style={styles.productionValue}>{r.value}</Text>
            <Text style={styles.productionSecondary}>{r.secondary ?? ""}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// --- linear chart bar geometry ------------------------------------------------

const BAR_VIEWBOX_W = 400;
const BAR_VIEWBOX_H = 16;

function clampPct(value: number, min: number, max: number): number {
  const p = ((value - min) / (max - min)) * BAR_VIEWBOX_W;
  return Math.max(0, Math.min(BAR_VIEWBOX_W, p));
}

function barColor(row: ProofCardLinearRow): string {
  if (row.favourable === "intermediate") return BAR_INTERMEDIATE;
  const good = row.favourable === "left" ? row.value <= 0 : row.favourable === "right" ? row.value >= 0 : row.value >= 0;
  return good ? BAR_FAVOURABLE : BAR_UNFAVOURABLE;
}

/** One trait's horizontal bar track: zero-line + filled bar clamped to [min,max]. */
function LinearBar({ row }: { row: ProofCardLinearRow }) {
  const zero = clampPct(0, row.min, row.max);
  const p = clampPct(row.value, row.min, row.max);
  const barX = Math.min(zero, p);
  const barW = Math.max(Math.abs(p - zero), 2);
  return (
    <Svg viewBox={`0 0 ${BAR_VIEWBOX_W} ${BAR_VIEWBOX_H}`} style={{ width: "100%", height: 11 }}>
      <Rect x={0} y={5} width={BAR_VIEWBOX_W} height={6} fill={ROW_STRIPE} />
      <Rect x={barX} y={4} width={barW} height={8} fill={barColor(row)} />
      <Line x1={zero} y1={0} x2={zero} y2={BAR_VIEWBOX_H} stroke={NAVY_MUTED} strokeWidth={1} />
    </Svg>
  );
}

function fmtSigned(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * The big linear chart: navy strip header, one row per trait (navy name+value
 * cell / light left-descriptor cell / white bar area / right-descriptor cell),
 * optional slim group dividers, and a bottom axis row.
 *
 * Axis ticks use the FIRST row's [min,max] as the shared scale (a single axis
 * row cannot represent two different trait scales at once; callers whose rows
 * mix scales should split into multiple LinearChartTable calls instead).
 */
export function LinearChartTable({
  proofDateLabel,
  typeReliabilityLabel,
  countLabel,
  dataSource,
  rows,
  proofDateText = "Proof Date",
  typeReliabilityText = "Type Reliability",
  dataSuppliedByText,
}: {
  proofDateLabel: string;
  typeReliabilityLabel: string;
  countLabel: string;
  dataSource: string;
  rows: ProofCardLinearRow[];
  /** Header-strip prefix for the proof-date cell, e.g. "Proof Date" (English
   *  default) or "Date de l'épreuve" (FR_CA_LABELS.proofDate) — a locale-aware
   *  caller passes its translated prefix; omitting it keeps the English
   *  default unchanged, so no existing caller breaks. */
  proofDateText?: string;
  /** Header-strip prefix for the type-reliability cell — same override
   *  pattern as proofDateText (e.g. FR_CA_LABELS.typeReliability). */
  typeReliabilityText?: string;
  /**
   * The ENTIRE fourth strip cell (prefix + data source already combined),
   * e.g. FR_CA_LABELS.dataSuppliedBy = "Données fournies par CDN" — unlike
   * proofDateText/typeReliabilityText this is not just a prefix, because the
   * French labels bake the source name into the translated sentence. Omit to
   * fall back to the existing "Data supplied by {dataSource}" English text.
   */
  dataSuppliedByText?: string;
}) {
  const axisMin = rows[0]?.min ?? -15;
  const axisMax = rows[0]?.max ?? 15;
  const step = (axisMax - axisMin) / 6;
  const ticks = Array.from({ length: 7 }, (_, i) => Math.round(axisMin + step * i));

  let lastGroup: string | null | undefined;

  return (
    <View style={styles.linearOuter}>
      <View style={styles.linearStrip}>
        <Text style={styles.linearStripText}>{proofDateText}: {proofDateLabel}</Text>
        <Text style={styles.linearStripText}>{typeReliabilityText}: {typeReliabilityLabel}</Text>
        <Text style={styles.linearStripText}>{countLabel}</Text>
        <Text style={styles.linearStripText}>{dataSuppliedByText ?? `Data supplied by ${dataSource}`}</Text>
      </View>

      {rows.map((row, i) => {
        const showDivider = !!row.group && row.group !== lastGroup;
        lastGroup = row.group;
        return (
          <Fragment key={row.code}>
            {showDivider && (
              <View style={styles.linearGroupDivider}>
                <Text style={styles.linearGroupDividerText}>{row.group}</Text>
              </View>
            )}
            <View style={[styles.linearRow, i % 2 === 1 ? { backgroundColor: ROW_STRIPE } : {}]}>
              <View style={styles.linearNameCell}>
                <Text style={styles.linearNameText}>{row.name}</Text>
                <Text style={styles.linearValueText}>{fmtSigned(row.value)}</Text>
              </View>
              <View style={styles.linearDescLeftCell}>
                <Text style={styles.linearDescText}>{row.left}</Text>
              </View>
              <View style={styles.linearBarCell}>
                <LinearBar row={row} />
              </View>
              <View style={styles.linearDescRightCell}>
                <Text style={styles.linearDescText}>{row.right}</Text>
              </View>
            </View>
          </Fragment>
        );
      })}

      <View style={styles.linearAxisRow}>
        <View style={styles.linearAxisSpacer} />
        <View style={styles.linearAxisSpacerLeft} />
        <View style={styles.linearAxisTicks}>
          {ticks.map((t, i) => (
            <Text key={i} style={styles.linearAxisTickText}>
              {t}
            </Text>
          ))}
        </View>
        <View style={styles.linearAxisSpacerRight} />
      </View>
    </View>
  );
}

// Re-export react-pdf primitives the country templates need directly
// (Document/Page/View/Text), so a template only has one import line for
// "everything proof-card related" plus this file for raw react-pdf pieces
// it composes itself (e.g. its own top-level <Document>/<Page>).
export { Document, Page, View, Text, StyleSheet };
