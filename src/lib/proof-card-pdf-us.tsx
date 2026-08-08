import {
  Document,
  Page,
  View,
  Text,
  styles,
  HeaderBand,
  TwoBoxRow,
  LifetimeBox,
  FunctionalTraitsBox,
  ProductionBox,
  LinearChartTable,
  PT_WIDTH,
  PT_HEIGHT,
  TEXT_DARK,
  type ProofCardLinearRow,
  type ProofCardFunctionalCell,
} from "./proof-card-shared";
import type { UsProofCardData } from "./proof-card-us";
import { FR_US_LABELS, US_GROUP_NAMES } from "./proof-card-fr";

// ---------------------------------------------------------------------------
// American Proof Card — react-pdf <Document>, English or French labels.
//
// Sibling of proof-card-pdf-ca.tsx, not a fork of it: same shared primitives,
// same TwoBoxRow/LifetimeBox/FunctionalTraitsBox/ProductionBox/LinearChartTable
// layout. Only the field bindings, the header strip's four labels, and the
// GTPI/NET MERIT titles differ, because that is all that differs on the
// reference template between the two countries' cards.
//
// LOCALE. `locale` defaults to "en" so no existing caller breaks. When "fr",
// every string this file itself hardcodes or reads off row.name/row.left/
// row.right/row.group/cell.label is swapped for its FR_US_LABELS equivalent,
// falling back to English whenever a lookup key is missing. Two documented
// gaps, both resolved by falling back to English rather than guessing:
//   1. FR_US_LABELS has no proofDate/typeReliability fields (unlike
//      FrCaLabels) — proof-card-fr.ts's own header comment describes this
//      file as complete for the US card's group headers, composite names,
//      and functional labels, but does not claim those two header-strip
//      prefixes for the US side, and inventing French text proof-card-fr.ts
//      was never asked to contain would be a guess, not a translation. Both
//      LinearChartTable overrides are left unset for the US card in French,
//      which falls back to LinearChartTable's own English defaults.
//   2. FR_US_LABELS.functionalLeft[2] ("Filles/Troupeaux") is a literal
//      Daughters/Herds translation that does not describe this slot's real
//      content on the American card (the Daughter-Proven/Genomic Proof Basis
//      indicator) — proof-card-fr.ts's own file-level ambiguity note #2 flags
//      this exact mismatch and instructs the integration phase NOT to wire it
//      unchanged. That one cell (code "PROOF_BASIS") keeps its English label
//      in French mode instead; see usFrFunctionalLeft below.
// ---------------------------------------------------------------------------

/** Signed, thousands-separated integer (or "—" for a missing value). */
function fmtSignedInt(v: number | null): string {
  if (v == null) return "—";
  const rounded = Math.round(v);
  return rounded > 0 ? `+${rounded.toLocaleString()}` : rounded.toLocaleString();
}

/** Unsigned, thousands-separated integer (or "—"). GTPI is a ~3,400-point scale,
 *  never shown with a leading "+" — same rule US_KEY_TRAITS.formatUsTrait already
 *  applies for GTPI on the animal profile page. */
function fmtInt(v: number | null): string {
  if (v == null) return "—";
  return Math.round(v).toLocaleString();
}

/** Signed percent to 2dp (or "—"). Used for Fat%/Protein% breeding-value deviations. */
function fmtSignedPct(v: number | null): string {
  if (v == null) return "—";
  return v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
}

/** milkRel is already a 0-100 percent (not a 0-1 fraction) — see the schema
 *  comment on UsEvaluation.milkRel and the note on UsProofCardData.milkRel. */
function relPercent(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}

/** Translates one composite/linear row's NAME, LEFT/RIGHT descriptors, and
 *  GROUP header for French, falling back to the row's own English text for
 *  any lookup that misses. Numbers pass through untouched. */
function translateUsRow(row: ProofCardLinearRow): ProofCardLinearRow {
  return {
    ...row,
    name: FR_US_LABELS.linearTraitNames[row.code] ?? row.name,
    left: FR_US_LABELS.linearDescriptors[row.left] ?? row.left,
    right: FR_US_LABELS.linearDescriptors[row.right] ?? row.right,
    group: row.group ? US_GROUP_NAMES[row.group] ?? row.group : row.group,
  };
}

/** Positional label swap for the American card's LEFT functional column,
 *  matching frFunctionalCells' rule on proof-card-pdf-ca.tsx — EXCEPT slot 2
 *  (code "PROOF_BASIS"), which stays English. See the file-level locale note
 *  above (gap 2): FR_US_LABELS.functionalLeft[2] is a literal Daughters/Herds
 *  translation that does not describe this slot's real Proof-Basis content,
 *  and proof-card-fr.ts's own ambiguity note instructs this integration not
 *  to wire it in unchanged — so this one cell falls back to English instead
 *  of showing a mismatched label. */
function usFrFunctionalLeft(cells: ProofCardFunctionalCell[]): ProofCardFunctionalCell[] {
  return cells.map((c, i) => (c.code === "PROOF_BASIS" ? c : { ...c, label: FR_US_LABELS.functionalLeft[i] ?? c.label }));
}

function frFunctionalCells(cells: ProofCardFunctionalCell[], frLabels: string[]): ProofCardFunctionalCell[] {
  return cells.map((c, i) => ({ ...c, label: frLabels[i] ?? c.label }));
}

export function UsProofCardPdf({ data, locale = "en" }: { data: UsProofCardData; locale?: "en" | "fr" }) {
  const fr = locale === "fr";
  const relPct = relPercent(data.milkRel);
  const typeRelLabel = relPct != null ? `${relPct}%` : "—";

  // One shared axis: composite rows (PTAT/UDC/FLC[/BSC]) and the 17 two-ended
  // traits are both CDCB standardised deviations on the same ±3 track
  // (US_LINEAR_MIN/MAX), so — unlike a case that mixed scales — a single
  // LinearChartTable call with one bottom axis row is correct here, not just
  // convenient.
  const rawChartRows = [...data.compositeRows, ...data.linearRows];
  const chartRows = fr ? rawChartRows.map(translateUsRow) : rawChartRows;

  const functionalLeft = fr ? usFrFunctionalLeft(data.functionalLeft) : data.functionalLeft;
  const functionalRight = fr ? frFunctionalCells(data.functionalRight, FR_US_LABELS.functionalRight) : data.functionalRight;

  return (
    <Document>
      <Page size={[PT_WIDTH, PT_HEIGHT]} style={styles.page}>
        <HeaderBand flag="🇺🇸" country="UNITED STATES" title={fr ? FR_US_LABELS.title : "AMERICAN FIGURES"} />

        <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 }}>
          <Text style={{ fontSize: 12, fontWeight: 700, color: TEXT_DARK }}>{data.name}</Text>
          <Text style={{ fontSize: 7, color: "#64748b", marginTop: 1 }}>
            {data.breed}
            {data.naab ? `  ·  NAAB ${data.naab}` : ""}
            {data.id17 ? `  ·  ${data.id17}` : ""}
          </Text>
        </View>

        <View style={{ paddingHorizontal: 10, paddingTop: 4 }}>
          <TwoBoxRow
            leftWidthPct={40}
            left={
              <LifetimeBox
                title={fr ? FR_US_LABELS.lifetimePerformance : "Lifetime Performance"}
                relPercent={relPct}
                figures={[
                  { label: fr ? FR_US_LABELS.gtpi : "GTPI", value: fmtInt(data.tpi) },
                  { label: fr ? FR_US_LABELS.netMerit : "NET MERIT", value: fmtSignedInt(data.nmDollar) },
                ]}
              />
            }
            right={
              <FunctionalTraitsBox
                title={fr ? FR_US_LABELS.functionalTraits : "Functional Traits"}
                left={functionalLeft}
                right={functionalRight}
              />
            }
          />
        </View>

        <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>
          <ProductionBox
            title={fr ? FR_US_LABELS.production : "Production"}
            relPercent={relPct}
            rows={[
              { label: fr ? FR_US_LABELS.milk : "Milk", value: `${fmtSignedInt(data.milk)} lb` },
              { label: fr ? FR_US_LABELS.fat : "Fat", value: `${fmtSignedInt(data.fat)} lb`, secondary: fmtSignedPct(data.fatPct) },
              { label: fr ? FR_US_LABELS.protein : "Protein", value: `${fmtSignedInt(data.pro)} lb`, secondary: fmtSignedPct(data.proPct) },
            ]}
          />
        </View>

        <View style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10 }}>
          <LinearChartTable
            proofDateLabel={data.proofDateLabel ?? "—"}
            typeReliabilityLabel={typeRelLabel}
            countLabel={data.proofBasisLabel}
            dataSource="Holstein USA"
            dataSuppliedByText={fr ? FR_US_LABELS.dataSuppliedBy : undefined}
            rows={chartRows}
          />
        </View>
      </Page>
    </Document>
  );
}
