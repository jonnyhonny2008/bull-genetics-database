import "server-only";
import { prisma } from "./db";
import { usLinearGroups, US_LINEAR_SECTIONS, US_LINEAR_MIN, US_LINEAR_MAX } from "./us-cdcb/linear";
import { usTrait } from "./us-cdcb/trait-catalog";
import { cdcbRoundLabel, type CdcbFileId } from "./us-cdcb/file-kind";
import { PROVEN_REL_MIN } from "./us-cdcb/list-filters";
import type { ProofCardLinearRow, ProofCardFunctionalCell } from "./proof-card-shared";

// ---------------------------------------------------------------------------
// American Proof Card data layer.
//
// Loads ONE American animal's preferred official CDCB round and shapes it into
// everything the American PDF card needs. Reads UsAnimal/UsEvaluation ONLY —
// never GeneticEvaluation/Animal — the same separation
// src/app/(app)/us/animals/[id]/page.tsx documents and enforces for the
// American sire card, and follows that page's query shape exactly: only
// runKind="official" + approvalStatus="approved" rows are candidates, the
// recomputed isPreferred flag wins the tie, and the newest evaluationDate is
// the fallback for an animal imported before that recompute ran. No PDF/react
// code lives here; this file is pure data, the sibling of proof-card-ca.ts.
// ---------------------------------------------------------------------------

export interface UsLinearRow extends ProofCardLinearRow {
  group: string | null;
}

export interface UsProofCardData {
  usAnimalId: string;
  name: string;
  breed: string;
  naab: string | null;
  id17: string;

  // "Lifetime Performance" box — GTPI / NET MERIT $.
  tpi: number | null;
  nmDollar: number | null;

  // "Production" box — breeding-value figures from the evaluation, lb + %.
  milk: number | null;
  fat: number | null;
  fatPct: number | null;
  pro: number | null;
  proPct: number | null;
  /**
   * Already a 0-100 percent, NOT a 0-1 fraction like the Canadian card's
   * reliabilityOverall (see the schema comment on UsEvaluation.milkRel — it is
   * lifted straight out of relJson's published percentage). CDCB/HAUSA publish
   * no single overall-reliability figure the way Lactanet does, so this is the
   * one reliability number this schema carries, and — matching the precedent
   * proof-card-ca.ts already set for lifetimeReliability/productionReliability
   * sharing one column — it is reused for BOTH the Lifetime and Production
   * boxes' "Rel" badges and for the linear chart's "Type Reliability" line.
   */
  milkRel: number | null;

  // "Functional Traits" box — 6 + 6, in the reference card's column order.
  functionalLeft: ProofCardFunctionalCell[];
  functionalRight: ProofCardFunctionalCell[];

  // Linear chart header strip
  roundCode: string | null;
  proofDateLabel: string | null;
  /**
   * Replaces the Canadian card's Dtrs/Herds slot. The US side carries no
   * daughter/herd COUNT field at all (unlike Canada's real Int columns), so
   * per the app owner's decision this session this slot instead shows a
   * PROVEN-vs-GENOMIC indicator derived from milkRel against PROVEN_REL_MIN
   * (=80, src/lib/us-cdcb/list-filters.ts — this app's own existing,
   * documented cut for "daughters are in the evaluation", not a new number
   * invented for this card). "—" only when milkRel itself is unpublished.
   */
  proofBasisLabel: string;

  // Linear chart rows, top to bottom: the composite rows (PTAT/UDC/FLC, plus
  // BSC once it is ever resolved), then the 17 two-ended traits usLinearGroups()
  // returns (plus Feet & Legs Score once it is ever resolved). Rows with no
  // value on this proof are skipped, never zero-filled — same rule
  // getCaProofCardData already applies on the Canadian side.
  compositeRows: ProofCardLinearRow[];
  linearRows: UsLinearRow[];

  /**
   * "BSC" is the pre-2017 name for Holstein Association USA's Body Weight
   * Composite (BWC) — confirmed real and currently published, but by HAUSA,
   * not CDCB, and under no column or raw gptaJson code in this database
   * (checked all 70,571 real evaluation rows this session). HAUSA does not
   * ship it to us as a file, so — with the app owner's explicit approval —
   * this is COMPUTED here from HAUSA's own disclosed, unchanged-since-2016
   * formula, over real inputs we do have:
   *
   *   BWC = 0.23×Stature + 0.72×Strength + 0.08×Body Depth
   *       + 0.17×Rump Width − 0.47×Dairy Form
   *
   * "Rump Width" is assumed to be this schema's Thurl Width (trw) — the same
   * physical measurement under a differing regional name; HAUSA's own
   * published material does not use CDCB's "TRW" code, and no explicit
   * crosswalk confirming the two are identical was found. Treat this as a
   * reasonable, not certain, mapping.
   *
   * NEVER a stand-in for HAUSA's own published number: it is null whenever
   * ANY of the five inputs is null (never partial-computed), and the card
   * marks it visibly as computed, not an official HAUSA figure — this is a
   * different situation from HCC, which this app deliberately does NOT
   * compute, because HCC's formula is an undisclosed quadratic penalty that
   * can only be FITTED (worst miss 0.84 against HAUSA's own release). BWC's
   * formula is simple, linear, and fully disclosed, so an exact computation
   * from correct inputs is a different kind of number, not an approximation.
   */
  bsc: number | null;
  /**
   * Confirmed real and currently published — a HAUSA index, not a CDCB one —
   * under no column or raw code in this database. Computed here, same
   * disclosure rule as bsc, from HAUSA's current (effective August 2024)
   * formula over real inputs already stored:
   *
   *   FI = 0.4×DPR + 0.4×CCR + 0.1×HCR + 0.1×EFC
   *
   * Null whenever any of the four inputs is null.
   */
  fertilityIndex: number | null;
  /**
   * Same status as bsc/fertilityIndex, but genuinely UNRESOLVED — a possible
   * extra linear-style "Feet & Legs Score" row (English) / "Indice P&M"
   * (French) seen on one reference template, separate from the FLC composite
   * box, confirmed absent from both the DB and US_LINEAR_ENDS this session,
   * and NOT covered by the BSC/Fertility Index research. Always null; the
   * linear-row list omits it (not dashes it) whenever null, so a later patch
   * that resolves what it really is needs no layout change.
   */
  feetLegsScore?: number | null;
}

type NumMap = Record<string, number>;

/** Mirrors the private parseMap() in the US sire card page exactly — decode
 *  gptaJson into a code -> value map, dropping anything non-numeric. Not
 *  imported from that page file on purpose: it is an app route, not a lib
 *  module meant to be imported elsewhere. */
function parseGptaMap(json: string | null): NumMap {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: NumMap = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** CDCB two-letter breed codes. Small enough, and private enough to the US
 *  sire card page (unexported there), that it is simplest kept local here too
 *  rather than importing an app route into a lib module. */
const BREED_NAMES: Record<string, string> = {
  AY: "Ayrshire", BS: "Brown Swiss", GU: "Guernsey", HO: "Holstein", JE: "Jersey", MS: "Milking Shorthorn",
};
function breedName(code: string | null | undefined): string | null {
  if (!code) return null;
  return BREED_NAMES[code] ?? code;
}

/**
 * usLinearGroups() returns each trait's display NAME, not its CDCB code — the
 * shared ProofCardLinearRow shape (and its React key in LinearChartTable)
 * needs a stable code the way CaLinearRow already carries one. This recovers
 * it from the same US_LINEAR_SECTIONS/usTrait data usLinearGroups() itself
 * reads internally, rather than inventing a new lookup — trait names are
 * unique across the 17, so the map is exact.
 */
function buildNameToCodeMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const section of US_LINEAR_SECTIONS) {
    for (const code of section.codes) m.set(usTrait(code)?.name ?? code, code);
  }
  return m;
}

export async function getUsProofCardData(usAnimalId: string): Promise<UsProofCardData | null> {
  const usAnimal = await prisma.usAnimal.findFirst({
    where: { usAnimalId, archived: false },
    select: { usAnimalId: true, id17: true, name: true, naabCode: true, breedCode: true },
  });
  if (!usAnimal) return null;

  // Same isPreferred-with-newest-fallback rule the US sire card page uses:
  // only official, approved rounds are candidates; the recomputed isPreferred
  // flag wins, and the newest evaluationDate is the fallback for an animal
  // imported before that recompute ran.
  const rounds = await prisma.usEvaluation.findMany({
    where: { usAnimalId, runKind: "official", approvalStatus: "approved" },
    orderBy: { evaluationDate: "desc" },
    select: {
      roundCode: true, evalBreed: true, naabCode: true, isPreferred: true,
      tpi: true, nmDollar: true,
      milk: true, fat: true, fatPct: true, pro: true, proPct: true, milkRel: true,
      scs: true, pl: true, cmDollar: true, ccr: true, dpr: true,
      ptat: true, udc: true, flc: true,
      // BWC ("BSC") inputs (STA/STR/BDE/TRW/DFM) and two of the four Fertility
      // Index inputs (HCR/EFC) are NOT indexed Prisma columns on UsEvaluation —
      // confirmed against prisma/schema.prisma, which declares no such fields,
      // and against a live query against .env.production, which throws P2022
      // "column does not exist" for any of them. They are real CDCB trait
      // codes, but published only inside gptaJson, the same as every other
      // JSON-only trait this file already reads via jsonCell() below (e.g.
      // "SCE"/"DCE"/"SSB"/"DSB"). See bsc/fertilityIndex below, which read
      // them from the decoded `gpta` map instead of a (nonexistent) `pref.*`.
      gptaJson: true,
    },
  });
  const pref = rounds.find((r) => r.isPreferred) ?? rounds[0] ?? null;
  if (!pref) return null; // no official, approved CDCB round at all

  const naab = pref.naabCode ?? usAnimal.naabCode ?? null;
  const breed = breedName(pref.evalBreed) ?? breedName(usAnimal.breedCode) ?? usAnimal.breedCode ?? "—";

  const gpta = parseGptaMap(pref.gptaJson);
  const jsonCell = (code: string): number | null => (typeof gpta[code] === "number" ? gpta[code] : null);

  const proofDateLabel = pref.roundCode
    ? cdcbRoundLabel({ family: null, kind: null, breed: null, roundCode: pref.roundCode, periodKey: null, date: pref.roundCode } as CdcbFileId)
    : null;

  const proofBasisLabel =
    pref.milkRel == null ? "—" : pref.milkRel >= PROVEN_REL_MIN ? "Daughter-Proven" : "Genomic";

  const combinedFP = pref.fat != null && pref.pro != null ? pref.fat + pref.pro : null;

  // BWC ("BSC") and Fertility Index — COMPUTED, not HAUSA-published, with the
  // app owner's explicit approval. See UsProofCardData.bsc/fertilityIndex for
  // the formulas, sources and why this differs from HCC (never computed).
  // Round2 kept local — this is the only place in this file that needs it.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // STA/STR/BDE/TRW/DFM/HCR/EFC are JSON-only (see the query select comment
  // above) — read through the already-decoded `gpta` map, not `pref.*`.
  const sta = jsonCell("STA"), strT = jsonCell("STR"), bde = jsonCell("BDE"), trw = jsonCell("TRW"), dfm = jsonCell("DFM");
  const hcr = jsonCell("HCR"), efc = jsonCell("EFC");
  const bsc =
    sta != null && strT != null && bde != null && trw != null && dfm != null
      ? round2(0.23 * sta + 0.72 * strT + 0.08 * bde + 0.17 * trw - 0.47 * dfm)
      : null;
  const fertilityIndex =
    pref.dpr != null && pref.ccr != null && hcr != null && efc != null
      ? round2(0.4 * pref.dpr + 0.4 * pref.ccr + 0.1 * hcr + 0.1 * efc)
      : null;

  const functionalLeft: ProofCardFunctionalCell[] = [
    { code: "SCS", label: "SCS", value: pref.scs },
    { code: "PL", label: "Productive Life", value: pref.pl },
    { code: "PROOF_BASIS", label: "Proof Basis", value: proofBasisLabel },
    { code: "CFP", label: "Combined F&P", value: combinedFP },
    { code: "CM", label: "Cheese Merit $", value: pref.cmDollar },
    // "(calc.)" — computed in-house from HAUSA's published formula, not a
    // figure HAUSA supplied us directly. See UsProofCardData.fertilityIndex.
    { code: "FI", label: "Fertility Index (calc.)", value: fertilityIndex },
  ];
  const functionalRight: ProofCardFunctionalCell[] = [
    { code: "CCR", label: "CCR", value: pref.ccr },
    { code: "DPR", label: "DPR", value: pref.dpr },
    { code: "SCE", label: "Sire Calving Ease", value: jsonCell("SCE") },
    { code: "DCE", label: "Daughter Calving Ease", value: jsonCell("DCE") },
    { code: "SSB", label: "Sire Stillbirth", value: jsonCell("SSB") },
    { code: "DSB", label: "Daughter Stillbirth", value: jsonCell("DSB") },
  ];

  // Composite rows: PTAT / UDC / FLC, all confirmed real, HAUSA-published
  // columns. BSC ("BWC") is computed above — its name carries "(calc.)" so
  // the chart visibly distinguishes it from the three official figures beside
  // it, matching the same disclosure the Functional Traits box's Fertility
  // Index cell carries.
  const compositeSource: { code: string; name: string; value: number | null }[] = [
    { code: "PTAT", name: "PTAT", value: pref.ptat },
    { code: "UDC", name: "UDC", value: pref.udc },
    { code: "FLC", name: "FLC", value: pref.flc },
    { code: "BSC", name: "BSC (calc.)", value: bsc },
  ];
  const compositeRows: ProofCardLinearRow[] = compositeSource
    .filter((c): c is { code: string; name: string; value: number } => c.value != null)
    .map((c) => ({
      code: c.code,
      name: c.name,
      group: "Type Composites",
      value: c.value,
      min: US_LINEAR_MIN,
      max: US_LINEAR_MAX,
      left: "Poor",
      right: "Excellent",
      favourable: "right" as const,
    }));

  // The 17 two-ended linear traits — usLinearGroups() is the tested, owner-
  // approved source for which traits appear, their descriptor pairs, and
  // their favourable direction; nothing here re-derives any of that.
  const nameToCode = buildNameToCodeMap();
  const linearRows: UsLinearRow[] = [];
  for (const g of usLinearGroups(gpta)) {
    for (const t of g.traits) {
      linearRows.push({
        code: nameToCode.get(t.name) ?? t.name,
        name: t.name,
        group: g.group,
        value: t.value,
        min: t.min,
        max: t.max,
        left: t.left,
        right: t.right,
        favourable: t.favourable,
      });
    }
  }
  // Feet & Legs Score: genuinely unresolved (unlike BSC/Fertility Index above,
  // this one was not part of the research this session — see feetLegsScore on
  // UsProofCardData). Stays inert until a later patch resolves it.
  const feetLegsScore: number | null = null;
  if (feetLegsScore != null) {
    linearRows.push({
      code: "FLS",
      name: "Feet & Legs Score",
      group: "Type — feet & legs",
      value: feetLegsScore,
      min: US_LINEAR_MIN,
      max: US_LINEAR_MAX,
      left: "Poor",
      right: "Excellent",
      favourable: "right",
    });
  }

  return {
    usAnimalId: usAnimal.usAnimalId,
    name: usAnimal.name ?? usAnimal.id17,
    breed,
    naab,
    id17: usAnimal.id17,

    tpi: pref.tpi,
    nmDollar: pref.nmDollar,

    milk: pref.milk,
    fat: pref.fat,
    fatPct: pref.fatPct,
    pro: pref.pro,
    proPct: pref.proPct,
    milkRel: pref.milkRel,

    functionalLeft,
    functionalRight,

    roundCode: pref.roundCode,
    proofDateLabel,
    proofBasisLabel,

    compositeRows,
    linearRows,

    bsc,
    fertilityIndex,
    feetLegsScore,
  };
}
