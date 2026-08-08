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
  type ProofCardFunctionalCell,
} from "./proof-card-shared";
import type { CaProofCardData, CaLinearRow } from "./proof-card-ca";
import { FR_CA_LABELS, CA_GROUP_NAMES } from "./proof-card-fr";

// ---------------------------------------------------------------------------
// Canadian Proof Card — react-pdf <Document>, English or French labels.
//
// Pure presentation: every number is already on CaProofCardData, this file
// only formats and lays it out using the shared primitives from
// proof-card-shared.tsx. A later phase's American card is a sibling of this
// file, not a fork of it — it should import the same shared primitives.
//
// LOCALE. `locale` defaults to "en" so no existing caller breaks. When "fr",
// every string this file itself hardcodes or reads off row.name/row.left/
// row.right/row.group/cell.label is swapped for its FR_CA_LABELS equivalent,
// falling back to the English text whenever a lookup key is missing (a
// missing translation is never a crash — see translateRow/frFunctionalCells
// below). Numbers are never touched by locale — only text.
// ---------------------------------------------------------------------------

/** Signed, thousands-separated integer (or "—" for a missing value). */
function fmtSignedInt(v: number | null): string {
  if (v == null) return "—";
  const rounded = Math.round(v);
  return rounded > 0 ? `+${rounded.toLocaleString()}` : rounded.toLocaleString();
}

/** Signed percent to 2dp (or "—"). Used for Fat%/Protein% breeding-value deviations. */
function fmtSignedPct(v: number | null): string {
  if (v == null) return "—";
  return v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
}

/** 0-1 fraction -> rounded whole percent, or null through. */
function toPercent(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100);
}

/** Positional label swap for a functional-cell column: keeps the data layer's
 *  real .value untouched, only replaces .label with the FR array entry at the
 *  same index — falling back to the existing English label if that index is
 *  somehow absent (defensive; the arrays are hand-built to the same length as
 *  the data layer's columns). Never reorders, drops, or reinterprets a cell. */
function frFunctionalCells(cells: ProofCardFunctionalCell[], frLabels: string[]): ProofCardFunctionalCell[] {
  return cells.map((c, i) => ({ ...c, label: frLabels[i] ?? c.label }));
}

/** Translates one linear/composite row's NAME, LEFT/RIGHT descriptors, and
 *  GROUP header for French, falling back to the row's own English text for
 *  any lookup that misses (unmapped trait code, unmapped descriptor word, or
 *  unmapped group string). The row's numeric value/min/max/favourable are
 *  passed through unchanged — locale never touches a number. */
function translateCaRow(row: CaLinearRow): CaLinearRow {
  return {
    ...row,
    name: FR_CA_LABELS.linearTraitNames[row.code] ?? row.name,
    left: FR_CA_LABELS.linearDescriptors[row.left] ?? row.left,
    right: FR_CA_LABELS.linearDescriptors[row.right] ?? row.right,
    group: row.group ? CA_GROUP_NAMES[row.group] ?? row.group : row.group,
  };
}

export function CaProofCardPdf({ data, locale = "en" }: { data: CaProofCardData; locale?: "en" | "fr" }) {
  const fr = locale === "fr";
  const relPct = toPercent(data.lifetimeReliability);
  const prodRelPct = toPercent(data.productionReliability);
  const typeRelLabel = relPct != null ? `${relPct}%` : "—";

  const functionalLeft = fr ? frFunctionalCells(data.functionalLeft, FR_CA_LABELS.functionalLeft) : data.functionalLeft;
  const functionalRight = fr ? frFunctionalCells(data.functionalRight, FR_CA_LABELS.functionalRight) : data.functionalRight;
  const linearRows = fr ? data.linearRows.map(translateCaRow) : data.linearRows;

  return (
    <Document>
      <Page size={[PT_WIDTH, PT_HEIGHT]} style={styles.page}>
        <HeaderBand flag="🇨🇦" country="CANADA" title={fr ? FR_CA_LABELS.title : "CANADIAN FIGURES"} />

        <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 }}>
          <Text style={{ fontSize: 12, fontWeight: 700, color: TEXT_DARK }}>{data.name}</Text>
          <Text style={{ fontSize: 7, color: "#64748b", marginTop: 1 }}>
            {data.breed}
            {data.naab ? `  ·  NAAB ${data.naab}` : ""}
            {data.registration ? `  ·  Reg. ${data.registration}` : ""}
          </Text>
        </View>

        <View style={{ paddingHorizontal: 10, paddingTop: 4 }}>
          <TwoBoxRow
            leftWidthPct={40}
            left={
              <LifetimeBox
                title={fr ? FR_CA_LABELS.lifetimePerformance : "Lifetime Performance"}
                relPercent={relPct}
                figures={[
                  { label: fr ? FR_CA_LABELS.gpaLpi : "GPA LPI", value: fmtSignedInt(data.gpaLpi) },
                  { label: fr ? FR_CA_LABELS.proDollar : "PRO $", value: fmtSignedInt(data.proDollar) },
                ]}
              />
            }
            right={
              <FunctionalTraitsBox
                title={fr ? FR_CA_LABELS.functionalTraits : "Functional Traits"}
                left={functionalLeft}
                right={functionalRight}
              />
            }
          />
        </View>

        <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>
          <ProductionBox
            title={fr ? FR_CA_LABELS.production : "Production"}
            relPercent={prodRelPct}
            rows={[
              { label: fr ? FR_CA_LABELS.milk : "Milk", value: `${fmtSignedInt(data.milk)} kg` },
              { label: fr ? FR_CA_LABELS.fat : "Fat", value: `${fmtSignedInt(data.fat)} kg`, secondary: fmtSignedPct(data.fatPct) },
              { label: fr ? FR_CA_LABELS.protein : "Protein", value: `${fmtSignedInt(data.prot)} kg`, secondary: fmtSignedPct(data.protPct) },
            ]}
          />
        </View>

        <View style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10 }}>
          <LinearChartTable
            proofDateLabel={data.proofRun ?? "—"}
            typeReliabilityLabel={typeRelLabel}
            countLabel={`${fr ? FR_CA_LABELS.dtrsHerds : "Dtrs/Herds"}: ${data.daughters ?? "—"}/${data.herds ?? "—"}`}
            dataSource="CDN"
            proofDateText={fr ? FR_CA_LABELS.proofDate : undefined}
            typeReliabilityText={fr ? FR_CA_LABELS.typeReliability : undefined}
            dataSuppliedByText={fr ? FR_CA_LABELS.dataSuppliedBy : undefined}
            rows={linearRows}
          />
        </View>
      </Page>
    </Document>
  );
}
