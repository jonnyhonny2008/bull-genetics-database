import "server-only";
import { prisma } from "./db";
import { loadRankMap, pickPreferred } from "./priority";
import { attachTraits, traitDefMap } from "./eval-traits";
import { caFavourableEnd } from "./ca-linear";
import type { ProofCardLinearRow, ProofCardFunctionalCell } from "./proof-card-shared";

// ---------------------------------------------------------------------------
// Canadian Proof Card data layer.
//
// Loads ONE animal's preferred (highest-priority, most-recent) genetic
// evaluation and shapes it into everything the Canadian PDF card — and,
// later, a CSV/XLSX export built on this same shape — needs. No PDF/react
// code lives here; this file is pure data.
// ---------------------------------------------------------------------------

export interface CaLinearRow extends ProofCardLinearRow {
  group: string | null;
}

export interface CaProofCardData {
  animalId: string;
  name: string;
  breed: string;
  naab: string | null;
  registration: string | null;

  // "Lifetime Performance" box
  gpaLpi: number | null;
  proDollar: number | null;
  /** 0-1 fraction (evaluation.reliabilityOverall), not a percent. */
  lifetimeReliability: number | null;

  // "Production" box — breeding-value figures from the evaluation, kg + %.
  milk: number | null;
  fat: number | null;
  fatPct: number | null;
  prot: number | null;
  protPct: number | null;
  /**
   * Same field as lifetimeReliability. The schema stores exactly one
   * reliability figure per evaluation (reliabilityOverall) — there is no
   * separate per-index (LPI/Pro$/Production) reliability column to draw the
   * two "Rel XX%" badges from independently, so both badges show this value.
   */
  productionReliability: number | null;

  // "Functional Traits" box — 6 + 6, in the reference card's column order.
  functionalLeft: ProofCardFunctionalCell[];
  functionalRight: ProofCardFunctionalCell[];

  // Linear chart strip
  proofRun: string | null;
  reliabilityOverall: number | null;
  daughters: number | null;
  herds: number | null;

  // Linear chart rows (isLinear TraitDefinition rows this bull has a value for)
  linearRows: CaLinearRow[];
}

export async function getCaProofCardData(animalId: string): Promise<CaProofCardData | null> {
  const a = await prisma.animal.findFirst({
    where: { id: animalId, archived: false },
    include: {
      breed: true,
      identifiers: true,
      evaluations: true,
    },
  });
  if (!a) return null;

  const defMap = await traitDefMap();
  const evaluations = attachTraits(a.evaluations, defMap);

  const geRank = await loadRankMap("genetic_evaluation", a.breedId);
  const prefProof = pickPreferred(evaluations, {
    getSourceId: (e) => e.sourceId,
    getDate: (e) => e.evaluationDate,
    getApproval: (e) => e.approvalStatus,
    // Same-round tie → official beats interim, matching the animal profile page.
    getTieBreak: (e) => (e.runKind === "official" ? 0 : e.runKind === "interim" ? 1 : 2),
    rankMap: geRank,
    domainLabel: "genetic evaluations",
  });
  const pref = prefProof.chosen;
  if (!pref) return null; // no approved proof at all — caller shows an empty/error state

  const naab = a.identifiers.find((i) => i.idType === "naab")?.idValue ?? null;
  const registration = a.identifiers.find((i) => i.idType === "registration_ca")?.idValue ?? null;

  // traitsJson-only functional traits (no indexed column — read by code).
  const traitByCode = new Map(pref.traitValues.map((t) => [t.traitCode, t]));
  const jsonCell = (code: string): number | null => traitByCode.get(code)?.numericValue ?? null;

  // Left/right split and card labels come directly from this phase's spec
  // (the reference image's own column order and wording — e.g. "Dtr Calving
  // Ability" / "Body Condition" are the card's compact labels, shorter than
  // TraitDefinition.traitName's "Daughter Calving Ability" / "Body Condition
  // Score", which is what the rest of the app shows).
  const functionalLeft: ProofCardFunctionalCell[] = [
    { code: "FE", label: "Feed Efficiency", value: jsonCell("FE") },
    { code: "HL", label: "Herd Life", value: pref.hl },
    { code: "MR", label: "Mastitis Resistance", value: pref.mr },
    { code: "MDR", label: "Metabolic Disease Resistance", value: pref.mdr },
    { code: "HH", label: "Hoof Health", value: jsonCell("HH") },
    { code: "LP", label: "Lactation Persistency", value: jsonCell("LP") },
  ];
  const functionalRight: ProofCardFunctionalCell[] = [
    { code: "DF", label: "Daughter Fertility", value: pref.df },
    { code: "MSPD", label: "Milking Speed", value: jsonCell("MSPD") },
    { code: "MTMP", label: "Milking Temperament", value: jsonCell("MTMP") },
    { code: "CA", label: "Calving Ability", value: pref.ca },
    { code: "DCA", label: "Dtr Calving Ability", value: pref.dca },
    { code: "BCS", label: "Body Condition", value: jsonCell("BCS") },
  ];

  // Linear chart rows: the 5 composite indexes FIRST (Conformation/Mammary/
  // Feet & Legs/Dairy Strength/Rump — the first five rows on the reference
  // template), then every isLinear TraitDefinition applicable to this bull's
  // breed, ordered by displayOrder, paired with this bull's own value. Rows
  // with no value on this proof are skipped, never zero-filled.
  //
  // THE 5 COMPOSITES ARE NOT isLinear=true IN THIS DATABASE (confirmed:
  // TraitDefinition has isLinear=false and leftLabel/rightLabel/graphMin/
  // graphMax all NULL for CONF/MAMM/FL/DS/RUMP — they were never given linear-
  // chart metadata, only seeded as plain indexed index columns). Rather than
  // flip that flag globally — which would also change the live on-screen
  // profile page's LinearGraph, a broader change than this card needs — they
  // are added HERE, scoped to the card only, with the descriptors and range
  // the reference template itself shows: "Poor"→"Excellent", -15..+15 (the
  // same default every other row already falls back to via `d.graphMin ?? -15`
  // above). The bull's own CONF/MAMM/FL/DS/RUMP VALUES are real, indexed
  // GeneticEvaluation columns — only the descriptor strings and axis range are
  // supplied by the card, not read from the database, because the database
  // has none stored for these five.
  const composites: { code: string; name: string; value: number | null }[] = [
    { code: "CONF", name: "Conformation", value: pref.conf },
    { code: "MAMM", name: "Mammary", value: pref.mamm },
    { code: "FL", name: "Feet & Legs", value: pref.fl },
    { code: "DS", name: "Dairy Strength", value: pref.ds },
    { code: "RUMP", name: "Rump", value: pref.rump },
  ];
  const linearRows: CaLinearRow[] = [];
  for (const c of composites) {
    if (c.value == null) continue;
    linearRows.push({
      code: c.code,
      name: c.name,
      group: "Composite Indexes",
      value: c.value,
      min: -15,
      max: 15,
      left: "Poor",
      right: "Excellent",
      favourable: "right",
    });
  }

  const breedId = a.breedId;
  const linearDefs = await prisma.traitDefinition.findMany({
    where: {
      domain: "genetic",
      isLinear: true,
      OR: breedId ? [{ breedId: null }, { breedId }] : [{ breedId: null }],
    },
    orderBy: { displayOrder: "asc" },
  });
  for (const d of linearDefs) {
    const t = traitByCode.get(d.traitCode);
    if (!t || t.numericValue == null) continue;
    linearRows.push({
      code: d.traitCode,
      name: d.traitName,
      group: d.graphGroup ?? null,
      value: t.numericValue,
      min: d.graphMin ?? -15,
      max: d.graphMax ?? 15,
      left: d.leftLabel ?? "",
      right: d.rightLabel ?? "",
      favourable: caFavourableEnd(d.traitCode, d.traitName, d.higherIsBetter),
    });
  }

  return {
    animalId: a.id,
    name: a.primaryName,
    breed: a.breed?.breedName ?? "—",
    naab,
    registration,

    gpaLpi: pref.lpi,
    proDollar: pref.proDollar,
    lifetimeReliability: pref.reliabilityOverall,

    milk: pref.milk,
    fat: pref.fat,
    fatPct: pref.fatPct,
    prot: pref.prot,
    protPct: pref.protPct,
    productionReliability: pref.reliabilityOverall,

    functionalLeft,
    functionalRight,

    proofRun: pref.proofRun,
    reliabilityOverall: pref.reliabilityOverall,
    daughters: pref.daughters,
    herds: pref.herds,

    linearRows,
  };
}
