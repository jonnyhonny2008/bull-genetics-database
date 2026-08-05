import "server-only";

// ---------------------------------------------------------------------------
// Mating Program report — orchestration.
//
// The user pastes up to 50 female registration numbers. For each female we rank
// the bull pool by the projected Parent Average of the hypothetical calf, having
// FIRST removed every bull that shares a registered ancestor with her inside D
// generations, and having WITHHELD every bull whose pedigree (or hers) is too
// thin for that "no shared ancestor" answer to mean anything.
//
// Two rules govern everything below:
//
//   WITHHOLDING, NOT DEMOTION. Users act on the top of whatever list they are
//   shown. A pair we could not verify is removed from the ranked list entirely
//   and reported in a separate panel that names the dark branch. It is never
//   merely pushed down.
//
//   FAIL CLOSED ON A DEGRADED FEMALE. A cow whose pedigree we cannot read
//   produces ZERO recommendations and an error row. A report that returns
//   nothing is a nuisance; one that returns confident nonsense produces a real
//   inbred calf.
//
// The relatedness predicate, the ancestor walk and the completeness measure all
// live in ./relatedness — this file only orchestrates, ranks and reports.
//
// --- QUERY PLAN -------------------------------------------------------------
// Five database round-trips, independent of how many females were pasted:
//   Q1  every active AnimalIdentifier        }  both inside loadPedigreeCorpus()
//   Q2  every PedigreeReference.notes        }
//   Q3  the candidate bull pool (indexed numeric columns ONLY — never traitsJson
//       and never holsteinProfileJson; those would be ~3.8 MB per run)
//   Q4  the pasted females that are animals we hold (<= 50 rows)
//   Q5  full traits for the SHORTLIST only — the bulls actually displayed
//       (deduped, hard cap 250). This is the query that keeps the report inside
//       the egress budget.
// Females we do not hold are resolved live from Lactanet by
// resolveParentForPA() (concurrency 4, cap 50, per-female errors isolated,
// never persisted). traitDefMap() is a process-lifetime cache, not a per-run
// query.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { unpackTraits, traitDefMap } from "./eval-traits";
import {
  computeParentAverage,
  resolveParentForPA,
  type PAAncestor,
  type PAParent,
  type PATrait,
} from "./parent-average";
import { blondinWhere } from "./sire-class";
import { breedFromReg } from "./pedigree";
import {
  LOWER_IS_BETTER,
  MATING_INDEXES,
  blendLabel,
  blendScores,
  clampBlend,
  clampWeakN,
  compareByScore,
  compositeScore,
  correctionTraits,
  describeSelection,
  matchScoreOf,
  parentAverage,
  parseTraitSelection,
  clampBalance,
  poolTraitStats,
  rankWeaknesses,
  selectActedWeaknesses,
  MATING_DISPLAY_TRAITS,
  rankIsComposite,
  type CompositeScore,
  type SelectedTrait,
  type TraitStats,
  type WeaknessInput,
} from "./mating-score";
import { KEY_TRAIT_CODES } from "./key-traits";
import {
  CORRECTION_TRAITS,
  correctionCentre,
  correctionTrait,
  deficit,
  improvesWeakness,
  isPositiveImprover,
  matingFit,
  worsensWeakness,
} from "./mating-targets";
import {
  ancestorSetFromPAParent,
  assessRelatedness,
  buildAncestorSet,
  darkBranchNote,
  floorForDepth,
  loadPedigreeCorpus,
  normalizeReg,
  type AncestorSet,
  type PedigreeCorpus,
  type SharedAncestor,
} from "./relatedness";

// --- the index menu ---------------------------------------------------------
//
// The menu itself, the sort direction and every line of the scoring maths live
// in ./mating-score — a PURE module with no `server-only` import, so the numbers
// that decide which bull a breeder is shown can be unit-tested directly. Both
// are re-exported here because the page and the Excel export have always read
// them from this module.

export { MATING_INDEXES, MATING_DISPLAY_TRAITS, matingDisplayOnly } from "./mating-score";
export type { SelectedTrait } from "./mating-score";

const MAX_FEMALES = 50;
const DEFAULT_TOP_N = 10;
const MAX_TOP_N = 50;
const DEFAULT_FLOOR = 0.75;
const LACTANET_CONCURRENCY = 4;

/**
 * Ceiling on the candidate pool read in Q3. The whole male lineup is ~945 rows
 * of nine numeric columns (~100 bytes each), so this reads the entire pool in
 * practice; the cap only exists so a much larger database cannot turn one page
 * load into an unbounded read.
 */
const CANDIDATE_CAP = 1200;

/** Hard cap on Q5. Beyond this, displayed bulls keep their index-only PA. */
const SHORTLIST_CAP = 250;

/**
 * How many exclusion records travel to the BROWSER per female. The whole report
 * object is handed to a client component, so every excluded record is serialised
 * into the RSC payload on each page load whether or not the panel is ever opened
 * — 50 females against the whole 945-bull database is tens of thousands of rows.
 * The exact count is always reported (`excludedTotal`); only the listing is cut,
 * closest relationship first. The Excel export asks for the full list, which it
 * needs to remain a complete audit trail and which never touches the browser.
 */
const EXCLUDED_DISPLAY_CAP = 25;

// --- public types -----------------------------------------------------------

export interface MatingParams {
  females: string[];
  /**
   * The PRIMARY index — the first selected trait. Everything that read this
   * before the blend existed still reads it and still means the same thing:
   * `paIndex`, `ownIndex` and the single-trait column are all this trait.
   */
  index: string;
  /**
   * Every trait the run is ranked on, with its weight, in the order selected.
   * Length 1 is the classic single-trait run — ranked on the raw projected calf
   * value, with no standardisation anywhere. Length > 1 is the standardised
   * blend; see src/lib/mating-score.ts for why a raw sum would be a lie.
   */
  selected: SelectedTrait[];
  topN: number;
  /** 0 = audit mode (screening OFF). 2 or 3 = generations screened. */
  maxGen: 0 | 2 | 3;
  /**
   * The four options the page offers, in the page's own vocabulary:
   *   blondin — the Blondin house lineup (a role filter, pushed into SQL)
   *   proven  — active bulls with daughter-based EBVs   (sireType "proven")
   *   genomic — active bulls with GPA genomics only     (sireType "genomic")
   *   all     — the whole male database
   * "proven" and "genomic" both IMPLY an active proof — the labels on the form
   * read "Active proven" / "Active genomic" — so they force requireActive on
   * regardless of the includeInactive toggle, and say so when they override it.
   */
  pool: "blondin" | "proven" | "genomic" | "all";
  includeInactive: boolean;
  floor: number;
  /** Restrict the pool to bulls carrying an active NAAB stud code (marketed semen). */
  naabOnly: boolean;
  /**
   * Allow a bull of a different breed than the female.
   *
   * OFF by default, because a same-breed mating is what is wanted virtually
   * every time and the lineup holds Jersey, Ayrshire and Brown Swiss bulls
   * alongside the Holsteins — before this existed, a Holstein cow could be
   * handed a Jersey sire at the top of her list with nothing on screen to say
   * so. It is a toggle rather than a hard rule because deliberate crossbreeding
   * is a real programme, and silently making it impossible would be its own
   * kind of wrong.
   */
  crossBreed: boolean;
  /**
   * How much a WEAKNESS counts against a bull, 0-1. See DEFAULT_BALANCE in
   * mating-score.ts: the stud breeds for an animal with no holes, so the blend
   * leans partly on the bull's worst selected trait rather than his average.
   */
  balance: number;
  /** True when `pool` came from the request rather than the default. */
  poolExplicit: boolean;
  // --- corrective mating ----------------------------------------------------
  /**
   * How the ranking splits between MERIT (raise the calf's index) and CORRECTION
   * (fix THIS cow's faults), 0-1. 1 is merit only — the classic ranking. Lower
   * leans on suiting her weaknesses. See DEFAULT_BLEND in mating-score.ts. Only
   * bites on a female who actually has a detected weakness; a strong cow is
   * ranked on merit whatever this says.
   */
  blend: number;
  /**
   * The floor's severity. Off (default): a bull is only set aside when he would
   * make a flagged weakness WORSE — "at least doesn't make it worse". On: a bull
   * must be POSITIVE (an improver) on every flagged weakness or he is set aside —
   * "only bulls that are positive for those traits", which can leave a cow with
   * few or no bulls, and says so when it does.
   */
  strictImprovers: boolean;
  /** How many of her worst faults the run acts on (hard floor + correction
   *  weight). KEY_TRAITS get first claim on the slots. */
  weakN: number;
}

export interface MatingMatch {
  bullId: string;
  name: string;
  reg: string | null;
  naab: string | null;
  /** The bull's own value for the chosen index. */
  ownIndex: number | null;
  /** Projected calf value: mean of bull and dam. Falls back to ownIndex when
   *  the dam has no value for the index — see MatingFemale.paBasis. */
  paIndex: number | null;
  /**
   * The bull's place on the blended scale: 100 is the pool average and every 5
   * points is one standard deviation of the weighted blend. null in a
   * single-trait run (nothing was standardised), and null for a bull missing
   * one of the selected traits — he is never scored on the traits he happens to
   * carry, which would flatter him for the one he is missing.
   */
  matchScore: number | null;
  /**
   * One entry per SELECTED trait, in the order selected. `own` is the bull's own
   * value and `pa` the projected calf figure shown in that trait's column — the
   * bull's own value when the dam has none, exactly as the single-trait column
   * has always behaved. A single-trait run carries one entry, which is the same
   * pair of numbers as ownIndex/paIndex.
   */
  traits: { code: string; label: string; own: number | null; pa: number | null }[];
  pa: { code: string; label: string; value: number }[];
  unavailable: { code: string; label: string; reason: string }[];
  tier: "clear" | "unknown" | "no-pedigree";
  /** min(pedComplete(cow), pedComplete(bull)) — the blinder half. */
  confidence: number;
  bullSlots: number;
  /**
   * Why this pair could not be certified, naming the branch that is dark and
   * WHICH SIDE it is on. Empty for a cleared pair. Confidence is min(cow,bull),
   * so a single thin female drags every bull below the floor — telling the user
   * "the bull's sire's parents are unknown" in that case is a false statement
   * about a bull whose pedigree is complete.
   */
  reason: string;
  /** The side that decided `confidence` — the half the screen was limited by. */
  blindSide: "female" | "bull" | null;
  /**
   * The flagged weaknesses this bull IMPROVES (labels), for a "fixes …" badge. A
   * weakness he merely holds level on is not listed — only ones he moves in the
   * right direction. Empty when she has no weaknesses, or he fixes none of them.
   */
  corrects: string[];
}

/** One of a cow's detected faults, shown so a recommendation explains itself. */
export interface FemaleWeakness {
  code: string;
  label: string;
  /** Her own value, on the trait's own scale. */
  cowValue: number;
  /** A plain-language goal: "looking for a bull above 100", "toward the 0 target". */
  goal: string;
  /** true = in the acted set (hard floor + correction weight). false = detected
   *  but past the weakN cut — shown, not acted on. */
  acted: boolean;
  /** true = enforced on the recommended shortlist only (Milking Speed, Bone
   *  Quality and the other traitsJson-only traits); false = enforced pool-wide. */
  deep: boolean;
}

export interface MatingFemale {
  /** Exactly what the user pasted on this line. */
  input: string;
  reg: string;
  name: string | null;
  source: "internal" | "lactanet" | null;
  cowSlots: number;
  cowComplete: number;
  basis: string | null;
  reliability: number | null;
  /** Screened and confident. THE ONLY ROWS THAT ARE RECOMMENDATIONS. */
  matches: MatingMatch[];
  /** Not enough pedigree to certify — shown separately, never recommended. */
  unknown: MatingMatch[];
  /**
   * Her detected weaknesses, worst first — the acted ones drive the floor and
   * the correction ranking, the rest are shown for context. Empty for a strong
   * cow, or when nothing about her could be read.
   */
  weaknesses: FemaleWeakness[];
  /** Deep traits (Milking Speed, Bone Quality …) we could not assess because she
   *  has no value for them on file — named, never guessed to be fine. */
  unassessedWeak: { code: string; label: string }[];
  /**
   * Bulls that CLEARED the relatedness screen but were set aside because they
   * would worsen one of her flagged weaknesses (or, in strict mode, are not
   * positive for it). Never recommended; the reason names the trait(s).
   */
  setback: { bullId: string; name: string; reg: string | null; naab: string | null; reasons: string[] }[];
  /** How many bulls were set aside for a weakness — never capped, never rounded. */
  setbackTotal: number;
  /** The closest exclusions, capped for the browser payload. See excludedTotal. */
  excluded: { bullId: string; name: string; shared: SharedAncestor[] }[];
  /** How many bulls were excluded in total — never capped, never rounded. */
  excludedTotal: number;
  notes: string[];
  error?: string;
  // --- additive, so the page can render the ranking column honestly ---------
  /** "pa" = mean of bull and dam. "bull-index" = the dam has no value for the
   *  chosen index, so nothing was averaged and the bull's own index is shown. */
  paBasis: "pa" | "bull-index";
  /** Ready-made heading for the ranking column, already relabelled when the
   *  projection could not be computed. */
  indexLabel: string;
  /**
   * One column per SELECTED trait, in the order selected, already headed for
   * THIS female: a trait she has no value for cannot be averaged, so its column
   * shows the bull's own number and says so in its own heading. A single-trait
   * run carries one entry, which duplicates indexLabel/paBasis.
   */
  traitColumns: { code: string; label: string; weight: number; basis: "pa" | "bull-index"; heading: string }[];
}

export interface MatingReport {
  females: MatingFemale[];
  params: MatingParams;
  /**
   * Whether a Match score is shown. True for a multi-trait blend, and true
   * whenever corrective mating is active for any female (the order is then the
   * merit/correction blend, not a raw projected calf value, so a legible score
   * column has to say what the order is). A single-trait run with no weaknesses
   * anywhere stays the classic raw-value report.
   */
  scored: boolean;
  /**
   * The completeness bar actually applied. Equal to params.floor at the default
   * 3-generation depth; at depth 2 the MacCluer sum is normalised over two
   * generations instead of three, so the floor is scaled by the same 3/D to stop
   * a shallower screen from doubling as a lower evidence bar.
   */
  effectiveFloor: number;
  /** Bulls that survived the pool + inactive filters and were screened. */
  bullsConsidered: number;
  /** Bulls dropped because they have no active proof (includeInactive false). */
  inactiveSuppressed: number;
  /** Median, across screened females, of excluded bulls as a % of the pool. */
  medianExclusionPct: number;
  /** Share of distinct ancestors met in this run that are animals we hold, and
   *  therefore could be alias-expanded. Low means the screen is running mostly
   *  on raw registration strings. */
  keyResolveRate: number;
  generatedAt: string;
  warnings: string[];
}

// --- parameter parsing ------------------------------------------------------

/** Split a paste box on newline / comma / tab / semicolon — but NEVER on a
 *  space, because "HOCANM 13486161" is one registration. An Excel column, a
 *  CSV line and a hand-typed list all paste straight in. */
const LINE_SPLIT = /[\r\n,\t;]+/;

interface ParsedInput {
  params: MatingParams;
  /**
   * Lines that are NOT registration-shaped but do normalise to something. They
   * are accepted only if they turn out to be a registration we actually hold —
   * checked against the corpus once it is loaded. Everything else joins
   * `unparseable`. A line like a leftover spreadsheet header ("Cow") must never
   * reach the live resolver, whose name-search fallback would substitute the
   * first animal whose name contains it and screen the whole run against that
   * stranger's pedigree.
   */
  candidates: string[];
  /** Lines we could not read as a registration, reported one by one so a single
   *  bad line never fails the run. */
  unparseable: string[];
  /** Lines dropped because the 50-female cap was already full. */
  overflow: string[];
  warnings: string[];
}

/** Canadian HOCANM…/HOCANF… and US/840 HO840M… shapes, plus anything that
 *  normalises to a registration we already hold. */
const REG_SHAPE = /^[A-Z]{2}[A-Z0-9]{3}[MF]\d+$/;

function looksLikeReg(raw: string): boolean {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return REG_SHAPE.test(s);
}

function parseParams(sp: Record<string, string | undefined>): ParsedInput {
  const warnings: string[] = [];

  // --- what the run is ranked on ---
  //
  // Two spellings, one meaning, because both have to keep working:
  //
  //   COMPACT   ?index=LPI            the classic single-trait run, untouched
  //             ?index=LPI,CONF       a blend, equal weights
  //             ?index=LPI:2,CONF:1   a blend, LPI counting double
  //   SLOTS     ?index=LPI&index2=CONF&weight1=2&weight2=1
  //
  // The form uses the slots because a plain GET form cannot join four fields
  // into one parameter without JavaScript; every saved link, every bookmark and
  // the Excel route use whichever they were built with. `weightN` applies to
  // slot N, and is ignored on a slot that already carries its own weight.
  const slotCodes = [sp.index, sp.index2, sp.index3, sp.index4];
  const slotWeights = [sp.weight1, sp.weight2, sp.weight3, sp.weight4];
  const tokens: string[] = [];
  slotCodes.forEach((raw, i) => {
    const code = (raw ?? "").trim();
    if (!code) return;
    const w = (slotWeights[i] ?? "").trim();
    // A slot that is already in the compact form carries its own weights.
    tokens.push(w && !code.includes(",") && !code.includes(":") ? `${code}:${w}` : code);
  });
  const sel = parseTraitSelection(tokens);
  warnings.push(...sel.warnings);
  const selected = sel.selected;
  // The PRIMARY trait. Everything written before the blend existed reads this
  // and still means exactly what it meant.
  const index = selected[0].code;

  const nRaw = Number.parseInt(sp.topN ?? "", 10);
  const topN = Number.isFinite(nRaw) ? Math.min(Math.max(nRaw, 1), MAX_TOP_N) : DEFAULT_TOP_N;

  const gRaw = (sp.maxGen ?? "").trim();
  const maxGen: 0 | 2 | 3 = gRaw === "0" || gRaw === "off" ? 0 : gRaw === "2" ? 2 : 3;

  let pool: MatingParams["pool"] = "blondin";
  const poolRaw = (sp.pool ?? "").trim().toLowerCase();
  // Whether the operator actually PICKED this pool. An empty pool that was
  // merely the default is a setup gap and falls back below; one that was chosen
  // deliberately is respected and explained instead.
  const poolExplicit = poolRaw !== "";
  // A bare "active" is the older vocabulary for "every bull with a current
  // proof, proven and genomic together". It has no button on the form, but a
  // bookmarked or hand-edited URL can still carry it, so it keeps working:
  // the whole database with the inactive bulls filtered out is exactly that
  // set. Recorded here so the toggle below cannot re-admit them.
  let legacyActive = false;
  if (poolRaw === "all" || poolRaw === "database") pool = "all";
  else if (poolRaw === "blondin" || poolRaw === "") pool = "blondin";
  else if (/^active[-_ ]?proven$/.test(poolRaw) || poolRaw === "proven") pool = "proven";
  else if (/^active[-_ ]?genomic$/.test(poolRaw) || poolRaw === "genomic") pool = "genomic";
  else if (poolRaw === "active") {
    pool = "all";
    legacyActive = true;
  } else {
    warnings.push(`Bull pool "${sp.pool}" is not recognised — used the Blondin lineup.`);
  }

  // The form field is named "inactive"; "includeInactive" is accepted too so a
  // caller that spells out the parameter (the Excel route, a saved link) gets
  // the same run as the form.
  const inactiveRaw = sp.inactive ?? sp.includeInactive;
  const includeInactive = !legacyActive && (inactiveRaw === "1" || inactiveRaw === "true");

  // Marketed sires only: a bull with no NAAB code has no stud code and cannot be
  // ordered, so recommending him wastes a slot in the lineup. Pushed into SQL as
  // an identifier EXISTS, which rides @@index([idType, idValue]).
  const naabRaw = sp.naabOnly ?? sp.naab;
  const naabOnly = naabRaw === "1" || naabRaw === "true";

  // Same breed unless explicitly asked otherwise — see MatingParams.crossBreed.
  const crossRaw = sp.crossBreed ?? sp.cross;
  const crossBreed = crossRaw === "1" || crossRaw === "true";

  // How hard a hole counts against a bull. Clamped, so a hand-edited URL cannot
  // push it outside the dial.
  const balance = clampBalance(sp.balance != null && sp.balance !== "" ? Number(sp.balance) : undefined);

  // --- corrective mating dials ---
  // How much the ranking leans on fixing HER faults vs raising the calf's index.
  const blend = clampBlend(sp.blend != null && sp.blend !== "" ? Number(sp.blend) : undefined);
  // Strict: a bull must be POSITIVE for every flagged weakness, not merely not
  // worsen it. Off by default — the never-worsen floor is always on regardless.
  const strictRaw = sp.strict ?? sp.strictImprovers;
  const strictImprovers = strictRaw === "1" || strictRaw === "true";
  // How many of her worst faults to act on.
  const weakN = clampWeakN(sp.weakN != null && sp.weakN !== "" ? Number(sp.weakN) : undefined);

  // The floor is CLAMPED AT THE DEFAULT, not at zero. 0.75 is the whole reason
  // the paternally blind cohort (0.583 — own pedigree line only, the sire's own
  // parents unknown) is withheld instead of recommended; a hand-edited ?floor=0
  // would relabel every one of those pairs "clear" while changing nothing about
  // what is actually known. A HIGHER bar is always allowed.
  const fRaw = Number.parseFloat(sp.floor ?? "");
  let floor = DEFAULT_FLOOR;
  if (Number.isFinite(fRaw)) {
    floor = Math.min(Math.max(fRaw, DEFAULT_FLOOR), 1);
    if (fRaw < DEFAULT_FLOOR) {
      warnings.push(
        `A completeness floor of ${fRaw} would certify pairings whose pedigrees cannot support the answer — the floor was held at the ${DEFAULT_FLOOR} minimum.`,
      );
    }
  }

  // --- the paste box ---
  const raw = sp.females ?? sp.regs ?? sp.f ?? "";
  const lines = raw.split(LINE_SPLIT).map((l) => l.trim()).filter(Boolean);

  const females: string[] = [];
  const candidates: string[] = [];
  const unparseable: string[] = [];
  const overflow: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = normalizeReg(line);
    if (!key) {
      unparseable.push(line);
      continue;
    }
    if (seen.has(key)) continue; // a duplicate is not an error, just a duplicate
    seen.add(key);
    if (females.length >= MAX_FEMALES) {
      overflow.push(line);
      continue;
    }
    const cleaned = line.replace(/\s+/g, " ");
    females.push(cleaned);
    // Registration-shaped lines go straight through; anything else has to prove
    // it is an animal we hold before it is allowed to become a female.
    if (!looksLikeReg(line)) candidates.push(cleaned);
  }

  return {
    params: {
      females, index, selected, topN, maxGen, pool, includeInactive, floor, naabOnly,
      crossBreed, balance, poolExplicit, blend, strictImprovers, weakN,
    },
    candidates,
    unparseable,
    overflow,
    warnings,
  };
}

// --- small helpers ----------------------------------------------------------

/** Bounded-concurrency map. Used only for the live Lactanet female lookups. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Turn an AncestorSet back into the PAAncestor[] shape parent-average.ts uses
 * for its own shared-ancestor note. Side is read off the relation path: only a
 * path rooted at the sire is a sire-side ancestor (MGS is the DAM's sire).
 * Display and note material only — the exclusion decision never reads it.
 */
function ancestorsFromSet(set: AncestorSet): PAAncestor[] {
  return [...set.entities.values()].map((s) => ({
    generation: s.gen,
    side: /^sire/i.test(s.path) ? ("sire" as const) : ("dam" as const),
    reg: s.reg,
    name: s.name,
  }));
}

// --- Q3: the candidate pool -------------------------------------------------

interface Candidate {
  animalId: string;
  name: string;
  proofStatus: string | null;
  sireType: string | null;
  /** Breed code (HO/JE/AY/BS/MS/AN) — the mating must not cross breeds by accident. */
  breedCode: string | null;
  /** Indexed column values, keyed by MATING_INDEXES code. */
  cols: Map<string, number | null>;
}

/**
 * The breed of an animal, preferring the registration over the breed table.
 *
 * A Canadian registration is BBCCCS######## — breed, country, sex, number — so
 * the first two letters ARE the breed and travel with the animal whether we hold
 * him or looked him up live seconds ago. The breed table is the fallback, since
 * a female pasted by the user may never become an Animal row at all.
 */
function breedOf(reg: string | null | undefined, fallback: string | null | undefined): string | null {
  return breedFromReg(reg) ?? (fallback ? fallback.toUpperCase() : null);
}

/**
 * The pool filter that can be pushed into SQL. The "active" restriction is
 * DELIBERATELY not here: it is applied in memory below so that
 * `inactiveSuppressed` is an exact count of what was withheld rather than a
 * silent absence.
 */
function poolWhere(pool: MatingParams["pool"], naabOnly = false): Prisma.AnimalWhereInput {
  const AND: Prisma.AnimalWhereInput[] = [];
  if (pool === "blondin") {
    const b = blondinWhere("1");
    if (b) AND.push(b);
  }
  // A NAAB code is what makes a bull orderable. Matching on idType alone (not on
  // a value shape) keeps this honest: whatever the importer wrote as the stud
  // code counts, and a bull who has none is simply not marketed.
  if (naabOnly) AND.push({ identifiers: { some: { idType: "naab", active: true } } });
  return AND.length ? { AND } : {};
}

// --- the report -------------------------------------------------------------

export async function getMatingProgramReport(
  sp: Record<string, string | undefined>,
  opts: {
    /** Keep every exclusion record instead of capping the list for the browser.
     *  Server-side consumers only — the Excel export needs the full audit trail. */
    fullExclusions?: boolean;
  } = {},
): Promise<MatingReport> {
  const generatedAt = new Date().toISOString();
  const { params, candidates: freeTextLines, unparseable, overflow, warnings: paramWarnings } = parseParams(sp);
  const warnings = [...paramWarnings];

  const selected = params.selected;
  // ONE trait is ranked on the raw projected calf value, exactly as this report
  // always has been. TWO OR MORE are standardised across the pool and blended —
  // see src/lib/mating-score.ts for why adding them up would be a lie.
  const multi = rankIsComposite(selected);
  const idx = MATING_INDEXES.find((i) => i.code === params.index)!;
  const higherIsBetter = !LOWER_IS_BETTER.has(idx.code);
  if (!multi && !higherIsBetter) {
    warnings.push(`${idx.label}: a LOWER value is the better animal, so this run is ranked ascending.`);
  }

  for (const line of unparseable) {
    warnings.push(`Could not read "${line}" as a registration number — that line was skipped.`);
  }
  if (overflow.length) {
    warnings.push(
      `Only the first ${MAX_FEMALES} females were used; ${overflow.length} further line${overflow.length === 1 ? " was" : "s were"} ignored.`,
    );
  }
  if (params.maxGen === 0) {
    warnings.push(
      "AUDIT MODE — relatedness screening is OFF. Nothing here has been cleared for mating: every bull is listed unverified, and the excluded panel shows only what a 3-generation screen WOULD have removed.",
    );
  }

  // Ancestor sets are built to the depth actually screened, and the floor is
  // scaled to that depth so a shallower screen cannot double as a lower bar.
  const buildGenForFloor: 2 | 3 = params.maxGen === 2 ? 2 : 3;
  const effectiveFloor = round2(floorForDepth(params.floor, buildGenForFloor));
  if (effectiveFloor !== params.floor) {
    warnings.push(
      `Screening to ${params.maxGen} generations measures pedigree completeness over ${buildGenForFloor} generations instead of 3, so the ${Math.round(params.floor * 100)}% floor was scaled to ${Math.round(effectiveFloor * 100)}% — the same amount of evidence, not a lower bar. A shallower screen must not make a thinner pedigree acceptable.`,
    );
  }

  const empty = (): MatingReport => ({
    females: [],
    params,
    scored: rankIsComposite(params.selected),
    effectiveFloor,
    bullsConsidered: 0,
    inactiveSuppressed: 0,
    medianExclusionPct: 0,
    keyResolveRate: 0,
    generatedAt,
    warnings,
  });
  if (params.females.length === 0) return empty();

  // Ancestor sets are built to the depth actually screened. Audit mode still
  // builds to 3 so the excluded panel can say what the screen would have caught.
  const buildGen: 2 | 3 = buildGenForFloor;

  // ---- Q1 + Q2: the whole-corpus pedigree walk (two queries, fixed cost) ----
  const corpus: PedigreeCorpus = await loadPedigreeCorpus(prisma);

  // A line that is not registration-shaped is only a female if it turns out to
  // be a registration we hold. Otherwise it is dropped HERE, before anything
  // reaches resolveParentForPA — whose name-search fallback would otherwise
  // substitute the first animal whose name merely contains the text and screen
  // the entire run against that stranger's pedigree, with no error shown.
  const freeText = new Set(freeTextLines);
  const rejected: string[] = [];
  const accepted = params.females.filter((input) => {
    if (!freeText.has(input)) return true;
    const key = normalizeReg(input);
    if (key && corpus.regToAnimalId.has(key)) return true;
    rejected.push(input);
    return false;
  });
  for (const line of rejected) {
    warnings.push(
      `"${line}" is not a registration number and is not an animal we hold — that line was skipped rather than matched by name.`,
    );
  }
  params.females = accepted;
  if (accepted.length === 0) return empty();

  // Which pasted females are animals we already hold?
  const femaleKeys = params.females.map((input) => ({ input, key: normalizeReg(input)! }));
  const internalIds = new Map<string, string>(); // key -> animalId
  for (const f of femaleKeys) {
    const id = corpus.regToAnimalId.get(f.key);
    if (id) internalIds.set(f.key, id);
  }

  const defMapPromise = traitDefMap(); // process-lifetime cache, not a per-run query

  // ---- Q3: candidate bulls. Indexed numeric columns only. -------------------
  // NEVER traitsJson and NEVER holsteinProfileJson here: at ~1.2 KB per bull
  // that is ~3.8 MB of egress on every single page load.
  //
  // The SQL order is the PRIMARY trait even in a blended run. It decides nothing
  // about the ranking — every candidate is re-ranked in memory below — it only
  // decides which rows survive if CANDIDATE_CAP ever truncates the read, and the
  // first-named trait is the most defensible tie-break for that.
  const orderBy = {
    [idx.col]: { sort: higherIsBetter ? "desc" : "asc", nulls: "last" },
  } as unknown as Prisma.GeneticEvaluationOrderByWithRelationInput;

  // Shared by the main pool read and the empty-pool fallback below, so the two
  // can never drift into selecting different columns.
  //
  // DERIVED from MATING_INDEXES, never hand-listed. A hand-written copy silently
  // fell three columns behind the menu once already: Fat %, Protein % and
  // Daughter Fertility were offered to rank on but never read, so every bull
  // came back with no value and the report said "no eligible bulls" while
  // blaming the proofs — "296 bulls have no Fat % on the preferred proof" — for
  // data that was in the database the whole time. Deriving it means adding a
  // trait to the menu cannot leave the query behind.
  const candidateSelect = {
    animalId: true,
    ...Object.fromEntries(MATING_INDEXES.map((i) => [i.col, true])),
    animal: {
      select: {
        primaryName: true, proofStatus: true, sireType: true,
        breed: { select: { breedCode: true } },
        // His own registration, so a bull with no breed row still resolves.
        identifiers: { where: { active: true, isPrimary: true }, select: { idValue: true }, take: 1 },
      },
    },
  } as Prisma.GeneticEvaluationSelect;

  const candidateRowsPromise = prisma.geneticEvaluation.findMany({
    where: {
      isPreferred: true,
      animal: { archived: false, sex: "M", ...poolWhere(params.pool, params.naabOnly) },
    },
    select: candidateSelect,
    orderBy,
    take: CANDIDATE_CAP,
  });

  // ---- Q4: the pasted females we hold (<= 50 rows) --------------------------
  // Mirrors resolveParentForPA's own evaluation choice (preferred first, else
  // the newest) so this report and the Parent Average page agree on a cow.
  const internalRowsPromise = internalIds.size
    ? prisma.animal.findMany({
        where: { id: { in: [...new Set(internalIds.values())] } },
        select: {
          id: true,
          primaryName: true,
          sex: true,
          // Fallback for the breed gate when her registration will not parse.
          breed: { select: { breedCode: true } },
          identifiers: {
            where: { active: true },
            orderBy: [{ isPrimary: "desc" }],
            take: 1,
            select: { idValue: true },
          },
          evaluations: {
            orderBy: [{ isPreferred: "desc" }, { evaluationDate: "desc" }],
            take: 1,
            select: { traitsJson: true, reliabilityOverall: true, proofRun: true, sireType: true },
          },
        },
      })
    : Promise.resolve([]);

  let [candidateRows, internalRows, defMap] = await Promise.all([
    candidateRowsPromise,
    internalRowsPromise,
    defMapPromise,
  ]);

  // An empty pool is a SETUP gap, not a screening result — without this the run
  // reports "0 eligible, 0 excluded, 0 unverifiable", which reads as "every bull
  // was rejected" when in truth none were ever looked at. The Blondin lineup is
  // the default and is empty until prisma/tag-blondin-animals.ts has been run,
  // so fall back to the whole database rather than hand back an empty report —
  // but only when the pool was the DEFAULT. A deliberately chosen empty pool is
  // respected and explained instead.
  if (candidateRows.length === 0 && params.pool === "blondin" && !params.poolExplicit) {
    const fallback = await prisma.geneticEvaluation.findMany({
      where: {
        isPreferred: true,
        animal: { archived: false, sex: "M", ...poolWhere("all", params.naabOnly) },
      },
      select: candidateSelect,
      orderBy,
      take: CANDIDATE_CAP,
    });
    if (fallback.length) {
      params.pool = "all";
      candidateRows = fallback;
      warnings.push(
        "No bull carries the Blondin tag yet, so this run used the whole database instead. " +
          "Run prisma/tag-blondin-animals.ts to mark the stud's own lineup, then the Blondin pool will work.",
      );
    }
  }

  if (candidateRows.length === 0) {
    warnings.push(
      params.naabOnly
        ? `No bull in the "${params.pool}" pool has an active NAAB code — nothing could be considered. Untick "NAAB code only" to widen the pool.`
        : `No bull matched the "${params.pool}" pool — nothing could be considered. This is an empty pool, not a screening result.`,
    );
  }

  if (candidateRows.length >= CANDIDATE_CAP) {
    warnings.push(`The bull pool was truncated at ${CANDIDATE_CAP} candidates — narrow the pool for a complete run.`);
  }

  // Dedupe (a bull should carry one preferred evaluation; keep the best-ranked).
  const seenBull = new Set<string>();
  const allCandidates: Candidate[] = [];
  for (const r of candidateRows) {
    if (seenBull.has(r.animalId)) continue;
    seenBull.add(r.animalId);
    allCandidates.push({
      animalId: r.animalId,
      name: r.animal?.primaryName ?? r.animalId,
      proofStatus: r.animal?.proofStatus ?? null,
      sireType: r.animal?.sireType ?? null,
      // The select is built from MATING_INDEXES, so Prisma cannot infer the row
      // shape and these two nested fields need naming explicitly.
      breedCode: (() => {
        const a = r.animal as unknown as {
          breed?: { breedCode: string | null } | null;
          identifiers?: { idValue: string }[];
        } | null;
        return breedOf(a?.identifiers?.[0]?.idValue, a?.breed?.breedCode);
      })(),
      // Derived from MATING_INDEXES for the same reason the select above is:
      // the two must cover exactly the traits the menu offers.
      cols: new Map<string, number | null>(
        MATING_INDEXES.map((i) => [i.code, (r as unknown as Record<string, number | null>)[i.col] ?? null]),
      ),
    });
  }

  // The active/inactive filter is applied here rather than in SQL so that
  // `inactiveSuppressed` is an EXACT count of what was withheld rather than a
  // silent absence. The "Active proven" and "Active genomic" pools carry the
  // word active in their own labels, so they win over the includeInactive
  // toggle — a contradiction between the two is reported, never resolved
  // quietly. "active" is matched strictly, the same as every other lineup list:
  // a bull whose proof status has never been classified is not known to have a
  // current proof, so he is not active.
  const poolIsActiveOnly = params.pool === "proven" || params.pool === "genomic";
  const requireActive = poolIsActiveOnly || !params.includeInactive;
  if (poolIsActiveOnly && params.includeInactive) {
    warnings.push(`Bull pool "${params.pool}" is an active-only lineup and "include inactive bulls" contradicts it — the pool won, and inactive bulls were left out.`);
  }
  const suppressed = requireActive ? allCandidates.filter((c) => c.proofStatus !== "active") : [];
  const inactiveSuppressed = suppressed.length;
  const unclassified = suppressed.filter((c) => c.proofStatus == null).length;
  if (unclassified) {
    warnings.push(`${unclassified} bull${unclassified === 1 ? " has" : "s have"} no proof status on record and were left out of the pool — run the sire classification if that looks wrong.`);
  }
  let candidates = requireActive ? allCandidates.filter((c) => c.proofStatus === "active") : allCandidates;

  // The proven/genomic split. Like the active filter this runs in memory, off
  // the sireType the Q3 select already carries, so it costs no extra query.
  // sireType is matched strictly for the same reason proofStatus is: a bull who
  // has never been classified is not known to be proven, and quietly ranking him
  // in a "proven only" run would be a false claim about his evidence base.
  if (poolIsActiveOnly) {
    const wanted = params.pool; // "proven" | "genomic"
    const wrongType = candidates.filter((c) => c.sireType !== wanted).length;
    candidates = candidates.filter((c) => c.sireType === wanted);
    if (wrongType) {
      warnings.push(`${wrongType} active bull${wrongType === 1 ? " is" : "s are"} not classified ${wanted} and were left out of the pool.`);
    }
  }

  // A bull with no value for a selected trait cannot be ranked on it. Dropping
  // him is stated, not silent — and in a blended run he is dropped rather than
  // scored on the traits he does carry, because scoring the survivors would
  // reward him for the trait he is missing, which is usually his weak one.
  for (const s of selected) {
    const missing = candidates.filter((c) => c.cols.get(s.code) == null).length;
    if (!missing) continue;
    candidates = candidates.filter((c) => c.cols.get(s.code) != null);
    warnings.push(
      multi
        ? `${missing} bull${missing === 1 ? " has" : "s have"} no ${s.label} on the preferred proof and could not be given a Match score. A bull is never scored on part of the blend — that would flatter him for the trait he is missing — so ${missing === 1 ? "he was" : "they were"} left out of the ranking.`
        : `${missing} bull${missing === 1 ? " has" : "s have"} no ${s.label} on the preferred proof and could not be ranked.`,
    );
  }

  if (candidates.length === 0) {
    warnings.push(
      `No bull in the "${params.pool}" pool has a rankable ${multi ? blendLabel(selected) : idx.label} — nothing could be recommended.`,
    );
  }

  // ---- the pool scale, computed ONCE ---------------------------------------
  // The scale a bull is measured against is the lineup he is being ranked
  // inside, so it is built here — after every pool filter, before the first
  // female. Recomputing it per female would make a bull's Match score mean a
  // different thing on each row of the same report.
  //
  // MERIT is now standardised for EVERY run, single trait included: the
  // corrective blend needs merit in standard deviations to combine it with the
  // correction term. For a female with no weakness the blend collapses to merit
  // alone, and sorting on that merit z-score gives the identical order to the
  // raw projected calf value — it is a monotonic rescale of the same number — so
  // a run that corrects nothing is byte-for-byte the report it always was.
  const meritStats: Map<string, TraitStats> = poolTraitStats(selected, candidates);
  const meritByBull = new Map<string, CompositeScore>();
  for (const c of candidates) meritByBull.set(c.animalId, compositeScore(c.cols, selected, meritStats, params.balance));
  // Only worth explaining a blend when there is a pool to explain, and only for a
  // real multi-trait blend — describeSelection returns nothing for one trait.
  if (multi && candidates.length) warnings.push(...describeSelection(selected, meritStats, candidates.length));

  // The CORRECTION scale: mean and spread of every INDEXED correction trait
  // across the pool, so a cow's fault can be measured as "how far below where
  // the bulls sit" and weighted against her other faults on one comparable
  // scale. Deep traits (Milking Speed, Bone Quality, the intermediate linears)
  // have no indexed column and are enforced per-bull on the shortlist instead.
  const indexedCorrection = CORRECTION_TRAITS.filter((t) => !t.deep);
  const correctionSelected: SelectedTrait[] = indexedCorrection.map((t) => ({
    code: t.code, label: t.label, col: "", weight: 1, higherIsBetter: !t.lowerIsBetter,
  }));
  const correctionStatsPool = poolTraitStats(correctionSelected, candidates);
  const centreOf = (code: string): number | null =>
    correctionCentre(code, correctionStatsPool.get(code)?.usable ? correctionStatsPool.get(code)!.mean : null);

  const bullSets = new Map<string, AncestorSet>();
  for (const c of candidates) bullSets.set(c.animalId, buildAncestorSet(c.animalId, corpus, buildGen));

  // ---- the females ---------------------------------------------------------
  const internalById = new Map(internalRows.map((r) => [r.id, r]));

  // Externals are resolved live from Lactanet, concurrency 4, never persisted.
  const externals = femaleKeys.filter((f) => !internalIds.has(f.key));
  const externalParents = await mapPool(externals, LACTANET_CONCURRENCY, async (f) => {
    try {
      return await resolveParentForPA(f.input);
    } catch (e) {
      return {
        found: false,
        reg: f.input.toUpperCase(),
        name: null,
        sex: null,
        source: null,
        inDatabase: false,
        animalId: null,
        reliabilityOverall: null,
        basis: null,
        proofRun: null,
        traits: new Map<string, PATrait>(),
        ancestors: [],
        error: e instanceof Error ? e.message : String(e),
      } satisfies PAParent;
    }
  });
  const externalByKey = new Map(externals.map((f, i) => [f.key, externalParents[i]]));

  // ---- screen + pre-rank ---------------------------------------------------
  // Pre-ranking uses the indexed column mean, which is by construction the same
  // number computeParentAverage() produces for that trait (the simple mean of
  // both parents). It exists only to choose WHICH bulls are worth a full trait
  // read; the displayed figures below come from computeParentAverage itself.
  interface Ranked {
    c: Candidate;
    tier: MatingMatch["tier"];
    confidence: number;
    bullSlots: number;
    /**
     * THE SORT KEY. Single trait: the raw projected calf value, sorted in that
     * trait's own direction. Blend: the standardised composite in standard
     * deviations, always highest-first because each trait's direction was
     * already applied when it was standardised.
     */
    pre: number | null;
    /** Projected calf value per SELECTED trait, aligned with `selected`. This is
     *  what is displayed; `pre` is only what is sorted on. */
    preValues: (number | null)[];
    /** 100 + 5 × the blended merit/correction score, or null when unscorable. */
    matchScore: number | null;
    reason: string;
    blindSide: MatingMatch["blindSide"];
    /** Labels of her acted faults this bull improves (for the "fixes …" badge). */
    corrects: string[];
  }

  /**
   * Why a pair could not be certified, naming the branch that is dark AND the
   * side it is on. Confidence is min(cow, bull), so one thin female drags every
   * bull below the floor — a fixed "the bull's sire's parents are unknown" would
   * be a false statement about bulls whose pedigrees are complete, and would send
   * the user off importing pedigrees that were never the problem.
   */
  const whyUnverified = (
    cowSet: AncestorSet,
    bullSet: AncestorSet,
    cowLabel: string,
  ): { reason: string; blindSide: MatingMatch["blindSide"] } => {
    const cowIsBlinder = cowSet.pedComplete <= bullSet.pedComplete;
    const blindSet = cowIsBlinder ? cowSet : bullSet;
    const who = cowIsBlinder ? cowLabel : "this bull";
    const note = darkBranchNote(blindSet);
    if (blindSet.keys.size === 0 || blindSet.pedComplete === 0) {
      return {
        reason: `${who} has no usable pedigree on file — nothing about this pair could be screened.`,
        blindSide: cowIsBlinder ? "female" : "bull",
      };
    }
    return {
      reason: `${who} is the blinder half: ${note ?? "part of the pedigree is unrecorded"}.`,
      blindSide: cowIsBlinder ? "female" : "bull",
    };
  };

  /** A cow fault carried through the loop into the assemble step. */
  interface Fault {
    code: string;
    label: string;
    cowValue: number;
    lowerIsBetter: boolean;
  }

  interface Draft {
    female: MatingFemale;
    parent: PAParent | null;
    clear: Ranked[];
    unverified: Ranked[];
    /** Bulls that cleared the pedigree screen but worsen an INDEXED acted fault
     *  (or, in strict mode, are not positive for it). Populated in the loop. */
    setback: MatingFemale["setback"];
    /** Deep acted faults (Milking Speed, Bone Quality, intermediate linears) to
     *  enforce against the recommended shortlist in the assemble step. */
    deepWeak: Fault[];
    /** Her full weakness list, for display. */
    weaknesses: FemaleWeakness[];
    /** Deep traits we could not read for her — named, never assumed fine. */
    unassessedWeak: MatingFemale["unassessedWeak"];
  }

  const drafts: Draft[] = [];
  const exclusionPcts: number[] = [];
  const entitySeen = new Set<string>();
  let entityResolved = 0;

  const noteEntities = (set: AncestorSet) => {
    for (const e of set.entities.keys()) {
      if (entitySeen.has(e)) continue;
      entitySeen.add(e);
      if (corpus.regsByAnimalId.has(e)) entityResolved++;
    }
  };
  for (const set of bullSets.values()) noteEntities(set);

  for (const f of femaleKeys) {
    const internalId = internalIds.get(f.key);
    const row = internalId ? internalById.get(internalId) : undefined;

    let parent: PAParent | null = null;
    let cowSet: AncestorSet | null = null;
    const notes: string[] = [];

    if (row) {
      const ev = row.evaluations[0] ?? null;
      const traits = new Map<string, PATrait>();
      if (ev) {
        for (const t of unpackTraits(ev.traitsJson, defMap)) {
          traits.set(t.traitCode, {
            value: t.numericValue,
            text: t.textValue,
            name: t.traitName,
            category: t.traitCategory,
            reliability: t.reliability,
          });
        }
      }
      cowSet = buildAncestorSet(row.id, corpus, buildGen);
      parent = {
        found: true,
        reg: row.identifiers[0]?.idValue ?? f.input,
        name: row.primaryName,
        sex: (row.sex as "M" | "F") ?? null,
        source: "internal",
        inDatabase: true,
        animalId: row.id,
        reliabilityOverall: ev?.reliabilityOverall ?? null,
        basis: ev?.sireType ?? null,
        proofRun: ev?.proofRun ?? null,
        traits,
        ancestors: ancestorsFromSet(cowSet),
      };
      if (row.sex === "M") notes.push(`${row.primaryName} is recorded as MALE in the database — check the registration number.`);
      if (!ev) notes.push("No genetic evaluation on file for this female — nothing could be averaged.");
    } else {
      const p = externalByKey.get(f.key) ?? null;
      parent = p;
      if (p?.found) cowSet = ancestorSetFromPAParent(p, corpus, buildGen);
    }

    // Her own value for each selected trait, aligned with `selected`. A trait
    // she has no number for cannot be averaged, so that column falls back to the
    // bull's own value — per trait, because a dam routinely has an LPI and no
    // Conformation, and one blanket "no parent average" would be false about the
    // traits she does carry.
    const damValues: (number | null)[] = selected.map((s) =>
      parent?.found ? parent.traits.get(s.code)?.value ?? null : null,
    );

    const base: MatingFemale = {
      input: f.input,
      reg: parent?.reg ?? f.input,
      name: parent?.name ?? null,
      source: parent?.source ?? null,
      cowSlots: cowSet?.slots ?? 0,
      cowComplete: cowSet ? round2(cowSet.pedComplete) : 0,
      basis: parent?.basis ?? null,
      reliability: parent?.reliabilityOverall ?? null,
      matches: [],
      unknown: [],
      weaknesses: [],
      unassessedWeak: [],
      setback: [],
      setbackTotal: 0,
      excluded: [],
      excludedTotal: 0,
      notes,
      paBasis: "pa",
      indexLabel: idx.label,
      traitColumns: selected.map((s, i) => ({
        code: s.code,
        label: s.label,
        weight: s.weight,
        basis: damValues[i] == null ? ("bull-index" as const) : ("pa" as const),
        heading: damValues[i] == null ? `Bull's own ${s.label}` : `Projected calf ${s.label}`,
      })),
    };
    const cowLabel = base.name ?? base.reg;

    if (!parent || !parent.found || !cowSet) {
      drafts.push({
        female: {
          ...base,
          error:
            parent?.error ??
            `Could not read ${f.input}'s pedigree — no recommendations produced.`,
        },
        parent: null,
        clear: [],
        unverified: [],
        setback: [],
        deepWeak: [],
        weaknesses: [],
        unassessedWeak: [],
      });
      continue;
    }

    noteEntities(cowSet);

    // FAIL CLOSED. A female with no ancestor keys, or with fewer than four
    // placed ancestors, cannot support a "no shared ancestor" answer. She gets
    // ZERO recommendations and an error row — never a quiet "no exclusions
    // found". (Audit mode is an explicit, labelled request for unscreened
    // output, so it is allowed through to the unverified panel.)
    const degraded = cowSet.keys.size === 0 || cowSet.slots < 4;
    if (degraded && params.maxGen !== 0) {
      const why = darkBranchNote(cowSet);
      drafts.push({
        female: {
          ...base,
          error: `Could not read ${base.reg}'s pedigree — no recommendations produced.`,
          notes: why ? [...notes, why] : notes,
        },
        parent,
        clear: [],
        unverified: [],
        setback: [],
        deepWeak: [],
        weaknesses: [],
        unassessedWeak: [],
      });
      continue;
    }
    if (degraded) notes.push(darkBranchNote(cowSet) ?? "Pedigree too thin to screen.");

    const damIndex = damValues[0];
    if (damIndex == null) {
      base.paBasis = "bull-index";
      base.indexLabel = `Bull index — dam has no ${idx.label}`;
      if (!multi) {
        notes.push(
          `${base.name ?? base.reg} has no ${idx.label}, so no parent average could be computed for it — the ranking below is the BULL'S OWN ${idx.label}, not a projection for the calf.`,
        );
      }
    }
    if (multi) {
      // The Match score is built from the bulls' OWN values in every case, so a
      // gap in her record never changes the ranking — only which columns beside
      // it are projections and which are the bull's own number.
      const gaps = base.traitColumns.filter((t) => t.basis === "bull-index");
      if (gaps.length) {
        notes.push(
          `${base.name ?? base.reg} has no ${gaps.map((g) => g.label).join(", ")}, so no parent average could be computed for ${gaps.length === 1 ? "that trait" : "those traits"} — ${gaps.length === 1 ? "that column shows" : "those columns show"} the BULL'S OWN value, not a projection for the calf. The Match score itself is unaffected: it is always built from the bulls' own values, standardised across the pool.`,
        );
      }
    }

    const clear: Ranked[] = [];
    const unverified: Ranked[] = [];
    const excluded: MatingFemale["excluded"] = [];

    // --- breed gate ---------------------------------------------------------
    // Her breed comes from her registration, which travels with her whether we
    // hold her or resolved her live. Bulls of another breed are dropped BEFORE
    // ranking rather than being ranked and then hidden, so the Match score is
    // standardised across the pool she is actually being offered.
    const cowBreed = breedOf(base.reg, row?.breed?.breedCode);
    const breedPool = params.crossBreed || !cowBreed
      ? candidates
      : candidates.filter((c) => !c.breedCode || c.breedCode === cowBreed);
    const breedSkipped = candidates.length - breedPool.length;
    if (breedSkipped > 0) {
      notes.push(
        `${breedSkipped} bull${breedSkipped === 1 ? "" : "s"} of another breed ${breedSkipped === 1 ? "was" : "were"} not considered — she is ${cowBreed}. Tick "allow other breeds" to include them.`,
      );
    }
    if (!cowBreed && !params.crossBreed) {
      notes.push(
        `Could not read a breed from ${base.reg}, so bulls of every breed were considered. Check the registration if this female should be limited to one breed.`,
      );
    }

    // --- HER WEAKNESSES, and the pool's ability to fix them ------------------
    // Measured against each correction trait's own base (see CORRECTION_TRAITS):
    // 100 for the functional RBVs, 0 for the linear/percent traits, the pool mean
    // for the composites. A trait she has no value for is named as unassessable,
    // never read as 0 — which is breed average, and would declare an unmeasured
    // cow perfect.
    const traitVal = (code: string): number | null => {
      const v = parent.traits.get(code)?.value;
      return v == null || !Number.isFinite(v) ? null : v;
    };
    const weakInputs: WeaknessInput[] = indexedCorrection.map((t) => {
      const st = correctionStatsPool.get(t.code);
      return {
        code: t.code,
        label: t.label,
        cowValue: traitVal(t.code),
        mean: correctionCentre(t.code, st?.usable ? st.mean : null),
        sd: st?.usable ? st.sd : null,
      };
    });
    const weakSet = rankWeaknesses(weakInputs, params.weakN, LOWER_IS_BETTER);
    const actedIndexed = selectActedWeaknesses(weakSet.ranked, params.weakN, new Set(KEY_TRAIT_CODES));
    const actedIndexedCodes = new Set(actedIndexed.map((w) => w.code));

    // Deep faults — no indexed column, so read from her own record here. The
    // DIRECTIONAL ones (Milking Speed, Bone Quality) are the traits the request
    // was about and are hard-floored on the recommended shortlist. The
    // INTERMEDIATE linears (stature, teat length …) are only SHOWN: enforcing
    // "never move any of seven both-way traits away from its optimum" as a hard
    // floor leaves almost no bull standing, and a 1-point drift off target is not
    // the fault a breeder means. They influence the display, nothing else.
    const deepWeak: Fault[] = [];
    const notedDeep: { code: string; label: string; cowValue: number }[] = [];
    const unassessedWeak: MatingFemale["unassessedWeak"] = [];
    for (const t of CORRECTION_TRAITS) {
      if (!t.deep) continue;
      const cv = traitVal(t.code);
      if (cv == null) {
        // Only the directional deep traits are ones a breeder asked to fix, so
        // only those are worth flagging as "couldn't assess". A missing linear is
        // left silent rather than nagging about a trait nobody asked to correct.
        if (!t.intermediate) unassessedWeak.push({ code: t.code, label: t.label });
        continue;
      }
      const centre = correctionCentre(t.code, null);
      if (centre == null) continue;
      if (!(deficit(t.code, cv, centre) > 0)) continue;
      if (t.intermediate) notedDeep.push({ code: t.code, label: t.label, cowValue: cv });
      else deepWeak.push({ code: t.code, label: t.label, cowValue: cv, lowerIsBetter: t.lowerIsBetter });
    }
    if (unassessedWeak.length) {
      notes.push(
        `Could not assess ${unassessedWeak.map((u) => u.label).join(", ")} for her — no value on file — so ${unassessedWeak.length === 1 ? "it was" : "they were"} not screened. Add her classification/genomic record to include ${unassessedWeak.length === 1 ? "it" : "them"}.`,
      );
    }

    // A plain-language goal per fault, and the assembled weakness list.
    const goalOf = (code: string, cowValue: number): string => {
      const t = correctionTrait(code);
      if (!t) return "looking to improve";
      if (t.intermediate) return `toward the ${t.base} target (she is ${round1(cowValue)})`;
      const centre = centreOf(code);
      if (centre == null) return `looking for a ${t.lowerIsBetter ? "lower" : "higher"} bull`;
      return `looking for a bull ${t.lowerIsBetter ? "below" : "above"} ${round1(centre)} (she is ${round1(cowValue)})`;
    };
    const mkWeak = (code: string, label: string, cowValue: number, acted: boolean, deep: boolean): FemaleWeakness => ({
      code, label, cowValue: round2(cowValue), goal: goalOf(code, cowValue), acted, deep,
    });
    const notedIndexed = weakSet.ranked.filter((w) => !actedIndexedCodes.has(w.code));
    const weaknesses: FemaleWeakness[] = [
      ...actedIndexed.map((w) => mkWeak(w.code, w.label, w.cowValue, true, false)),
      ...deepWeak.map((w) => mkWeak(w.code, w.label, w.cowValue, true, true)),
      ...notedIndexed.map((w) => mkWeak(w.code, w.label, w.cowValue, false, false)),
      ...notedDeep.map((w) => mkWeak(w.code, w.label, w.cowValue, false, true)),
    ];

    // The CORRECTION scale for THIS cow: every bull in her pool scored by how
    // well he suits her acted faults, standardised so it combines with merit.
    // matingFit turns each fault — directional or intermediate — into a number
    // where larger is better; a bull with no value for a fault is imputed the
    // pool-average fit (neutral), so a missing figure neither flatters nor buries
    // him. The floor, separately, only ever sets aside a bull we can SEE worsens
    // her.
    const fitOf = (w: { code: string; cowValue: number }, bull: number | null): number | null =>
      bull == null ? null : matingFit(w.code, w.cowValue, bull, LOWER_IS_BETTER.has(w.code));
    const fitPool = breedPool.map((c) => ({
      cols: new Map<string, number | null>(actedIndexed.map((w) => [w.code, fitOf(w, c.cols.get(w.code) ?? null)])),
    }));
    const fitStats = actedIndexed.length ? poolTraitStats(correctionTraits(actedIndexed), fitPool) : new Map<string, TraitStats>();
    const fitMean = new Map<string, number>();
    for (const [code, st] of fitStats) if (st.usable) fitMean.set(code, st.mean);
    // Only faults the pool can actually separate on carry the correction score;
    // an unusable one drops out rather than being divided by, and the weights
    // over the survivors stay proportional.
    const scoredWeak = actedIndexed.filter((w) => fitStats.get(w.code)?.usable);
    const scoredCols = correctionTraits(scoredWeak);
    const correctionZ = (c: Candidate): number | null => {
      if (!scoredWeak.length) return null;
      const cols = new Map<string, number | null>(
        scoredWeak.map((w) => {
          const raw = fitOf(w, c.cols.get(w.code) ?? null);
          return [w.code, raw == null ? (fitMean.get(w.code) ?? null) : raw];
        }),
      );
      return compositeScore(cols, scoredCols, fitStats, params.balance).composite;
    };

    // The never-worsen floor on the INDEXED acted faults, checked pool-wide. By
    // default a bull is set aside only when we can SEE he worsens one; in strict
    // mode he must be POSITIVE for every one, and a fault he has no value for
    // cannot be certified positive, so he is set aside there too.
    const indexedFloor = (c: Candidate): string[] => {
      const reasons: string[] = [];
      for (const w of actedIndexed) {
        const bv = c.cols.get(w.code) ?? null;
        const lower = LOWER_IS_BETTER.has(w.code);
        if (params.strictImprovers) {
          const centre = centreOf(w.code);
          if (bv == null) reasons.push(`no ${w.label} on his proof`);
          else if (centre != null && !isPositiveImprover(w.code, w.cowValue, bv, centre, lower)) reasons.push(`not positive for ${w.label}`);
        } else if (bv != null && worsensWeakness(w.code, w.cowValue, bv, lower)) {
          reasons.push(`would set back her ${w.label}`);
        }
      }
      return reasons;
    };
    const correctsOf = (c: Candidate): string[] =>
      actedIndexed
        .filter((w) => {
          const bv = c.cols.get(w.code) ?? null;
          return bv != null && improvesWeakness(w.code, w.cowValue, bv, LOWER_IS_BETTER.has(w.code));
        })
        .map((w) => w.label);

    const setback: MatingFemale["setback"] = [];

    for (const c of breedPool) {
      const bullSet = bullSets.get(c.animalId)!;
      // Projected calf value per selected trait — the displayed figures.
      const preValues = selected.map((s, i) => parentAverage(c.cols.get(s.code) ?? null, damValues[i]));
      // THE SORT KEY. Merit z-score, blended with how well the bull corrects HER
      // faults when she has any (blend = 1 leaves merit alone). For a female with
      // no acted fault this is the merit composite, whose order on one trait is
      // identical to the raw projected calf value.
      const merit = meritByBull.get(c.animalId) ?? null;
      const pre = scoredWeak.length
        ? blendScores(merit?.composite ?? null, correctionZ(c), params.blend)
        : merit?.composite ?? null;
      const matchScore = pre == null ? null : matchScoreOf(pre);

      if (params.maxGen === 0) {
        // Audit mode: nothing is withheld, but the screen is still RUN so the
        // excluded panel can show what it would have caught. Every bull lands
        // in the unverified list — none of this is a recommendation.
        const v = assessRelatedness(cowSet, bullSet, { maxGen: buildGen, floor: params.floor });
        if (v.shared.length) excluded.push({ bullId: c.animalId, name: c.name, shared: v.shared });
        unverified.push({
          c,
          tier: "unknown",
          confidence: 0,
          bullSlots: v.bullSlots,
          pre,
          preValues,
          matchScore,
          reason: "Audit mode — no relatedness screening was performed on this pair.",
          blindSide: null,
          corrects: [],
        });
        continue;
      }

      const v = assessRelatedness(cowSet, bullSet, { maxGen: params.maxGen, floor: params.floor });
      if (v.tier === "excluded") {
        excluded.push({ bullId: c.animalId, name: c.name, shared: v.shared });
      } else if (v.tier === "clear") {
        // THE NEVER-WORSEN FLOOR. A bull who cleared the pedigree screen but would
        // set back one of her acted faults (or, strict, is not positive for it) is
        // moved out of the recommendations entirely, not demoted inside them —
        // "at least doesn't make it worse". reg/naab are filled in at assemble if
        // he happens to be on the shortlist for another female.
        const reasons = indexedFloor(c);
        if (reasons.length) {
          setback.push({ bullId: c.animalId, name: c.name, reg: null, naab: null, reasons });
        } else {
          clear.push({
            c, tier: "clear", confidence: v.confidence, bullSlots: v.bullSlots, pre, preValues, matchScore,
            reason: "", blindSide: null, corrects: correctsOf(c),
          });
        }
      } else {
        // "unknown" and "no-pedigree" both mean UNVERIFIABLE. They are removed
        // from the ranked list, not demoted inside it. The tier is carried
        // through unchanged so "no pedigree at all" never reads as "some of the
        // pedigree is missing", and the reason names the side that is dark.
        unverified.push({
          c,
          tier: v.tier,
          confidence: v.confidence,
          bullSlots: v.bullSlots,
          pre,
          preValues,
          matchScore,
          ...whyUnverified(cowSet, bullSet, cowLabel),
          corrects: [],
        });
      }
    }

    // Highest score first, name as the tie-break. `pre` is now always a score
    // where larger is better (each trait's direction was applied when it was
    // standardised), so the single direction-aware branch the single-trait sort
    // once needed is gone — a one-trait run's merit z-score sorts identically to
    // its raw projected calf value.
    const byPre = (a: Ranked, b: Ranked) => compareByScore(a.pre, b.pre) || a.c.name.localeCompare(b.c.name);
    clear.sort(byPre);
    // Least-blind first inside the unverified panel, so "no pedigree at all"
    // (confidence 0) always sits at the bottom.
    unverified.sort((a, b) => b.confidence - a.confidence || byPre(a, b));
    excluded.sort(
      (a, b) =>
        (a.shared[0] ? a.shared[0].cowGen + a.shared[0].bullGen : 99) -
          (b.shared[0] ? b.shared[0].cowGen + b.shared[0].bullGen : 99) ||
        a.name.localeCompare(b.name),
    );

    if (candidates.length) exclusionPcts.push((excluded.length / candidates.length) * 100);

    const shownUnknown = unverified.slice(0, params.topN);
    if (unverified.length > shownUnknown.length) {
      notes.push(
        `${unverified.length - shownUnknown.length} further bull${unverified.length - shownUnknown.length === 1 ? "" : "s"} could not be verified and are not listed.`,
      );
    }

    // The whole report is handed to a client component, so an uncapped exclusion
    // list ships every record to the browser on every page load whether or not
    // the panel is ever opened. The COUNT is always exact; the listing keeps the
    // closest relationships, which are the ones worth reading. The Excel export
    // asks for the full list and never travels through the browser.
    const shownExcluded = opts.fullExclusions ? excluded : excluded.slice(0, EXCLUDED_DISPLAY_CAP);

    drafts.push({
      female: { ...base, excluded: shownExcluded, excludedTotal: excluded.length, notes, weaknesses, unassessedWeak },
      parent,
      clear: clear.slice(0, params.topN),
      unverified: shownUnknown,
      setback,
      deepWeak,
      weaknesses,
      unassessedWeak,
    });
  }

  // ---- Q5: full traits for the SHORTLIST only ------------------------------
  // Only the bulls that will actually be displayed as recommendations, deduped,
  // most-requested first, hard-capped. Pulling traitsJson for the whole lineup
  // instead of this shortlist is the difference between ~40 KB and ~3.8 MB.
  // Read off Animal rather than GeneticEvaluation so the registration number and
  // the NAAB code come back in the SAME round-trip as the traits — still one
  // query, and it keeps the plan at five.
  const demand = new Map<string, number>();
  for (const d of drafts) for (const r of d.clear) demand.set(r.c.animalId, (demand.get(r.c.animalId) ?? 0) + 1);
  const shortlist = [...demand.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHORTLIST_CAP).map(([id]) => id);
  if (demand.size > shortlist.length) {
    warnings.push(
      `${demand.size - shortlist.length} recommended bulls are beyond the ${SHORTLIST_CAP}-bull trait cap — their ${idx.label} projection is shown but the full trait breakdown is not.`,
    );
  }

  const bullRows = shortlist.length
    ? await prisma.animal.findMany({
        where: { id: { in: shortlist } },
        select: {
          id: true,
          primaryName: true,
          sex: true,
          identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } },
          evaluations: {
            orderBy: [{ isPreferred: "desc" }, { evaluationDate: "desc" }],
            take: 1,
            select: { traitsJson: true, reliabilityOverall: true, proofRun: true, sireType: true },
          },
        },
      })
    : [];

  const bullParents = new Map<string, PAParent>();
  const bullIds = new Map<string, { reg: string | null; naab: string | null }>();
  for (const b of bullRows) {
    const naab = b.identifiers.find((i) => i.idType === "naab")?.idValue ?? null;
    const reg =
      b.identifiers.find((i) => i.isPrimary && i.idType !== "naab")?.idValue ??
      b.identifiers.find((i) => i.idType !== "naab")?.idValue ??
      null;
    bullIds.set(b.id, { reg, naab });
    const ev = b.evaluations[0] ?? null;
    const traits = new Map<string, PATrait>();
    if (ev) {
      for (const t of unpackTraits(ev.traitsJson, defMap)) {
        traits.set(t.traitCode, {
          value: t.numericValue,
          text: t.textValue,
          name: t.traitName,
          category: t.traitCategory,
          reliability: t.reliability,
        });
      }
    }
    bullParents.set(b.id, {
      found: true,
      reg: reg ?? naab ?? b.id,
      name: b.primaryName,
      sex: (b.sex as "M" | "F") ?? "M",
      source: "internal",
      inDatabase: true,
      animalId: b.id,
      reliabilityOverall: ev?.reliabilityOverall ?? null,
      basis: ev?.sireType ?? null,
      proofRun: ev?.proofRun ?? null,
      traits,
      ancestors: ancestorsFromSet(bullSets.get(b.id) ?? buildAncestorSet(b.id, corpus, buildGen)),
    });
  }

  // ---- assemble ------------------------------------------------------------
  const females: MatingFemale[] = drafts.map((d) => {
    // The DEEP never-worsen floor: a recommended bull whose full trait record
    // (loaded for the shortlist) shows he would set back one of her deep faults —
    // Milking Speed, Bone Quality, an intermediate linear — is moved out of the
    // recommendations, exactly as the indexed floor does pool-wide. A deep trait
    // he has no value for cannot be called a setback and leaves him in place. A
    // bull beyond the shortlist cap has no full record to judge and is kept.
    const deepReasonsFor = (id: string): string[] => {
      const bp = bullParents.get(id);
      if (!bp) return [];
      const reasons: string[] = [];
      for (const w of d.deepWeak) {
        const bv = bp.traits.get(w.code)?.value ?? null;
        if (bv == null || !Number.isFinite(bv)) continue;
        if (params.strictImprovers) {
          const centre = correctionCentre(w.code, null);
          if (centre != null && !isPositiveImprover(w.code, w.cowValue, bv, centre, w.lowerIsBetter)) reasons.push(`not positive for ${w.label}`);
        } else if (worsensWeakness(w.code, w.cowValue, bv, w.lowerIsBetter)) {
          reasons.push(`would set back her ${w.label}`);
        }
      }
      return reasons;
    };
    const deepCorrectsFor = (id: string): string[] => {
      const bp = bullParents.get(id);
      if (!bp) return [];
      return d.deepWeak
        .filter((w) => {
          const bv = bp.traits.get(w.code)?.value ?? null;
          return bv != null && Number.isFinite(bv) && improvesWeakness(w.code, w.cowValue, bv, w.lowerIsBetter);
        })
        .map((w) => w.label);
    };

    const toMatch = (r: Ranked): MatingMatch => {
      const ids = bullIds.get(r.c.animalId);
      const bullParent = bullParents.get(r.c.animalId);
      const pa: MatingMatch["pa"] = [];
      const unavailable: MatingMatch["unavailable"] = [];
      /** computeParentAverage's own figure per code, where it produced one. */
      const paByCode = new Map<string, number>();
      // The PRIMARY trait's projected calf value — never the composite, which is
      // in standard deviations and would be nonsense in this field.
      let paIndex = r.preValues[0];

      if (bullParent && d.parent) {
        // computeParentAverage, unchanged and unforked. The displayed numbers
        // are ITS numbers, not the pre-rank's.
        const result = computeParentAverage(bullParent, d.parent);
        if (result.ok) {
          const byCode = new Map(result.pa.map((row) => [row.code, row]));
          const unavByCode = new Map(result.unavailable.map((u) => [u.code, u]));
          for (const m of MATING_DISPLAY_TRAITS) {
            const row = byCode.get(m.code);
            if (row) {
              pa.push({ code: m.code, label: m.label, value: row.pa });
              paByCode.set(m.code, row.pa);
              continue;
            }
            const u = unavByCode.get(m.code);
            const reason =
              u?.availableFor === "sire only"
                ? `dam has no ${m.label}`
                : u?.availableFor === "dam only"
                  ? `bull has no ${m.label}`
                  : `neither animal has ${m.label}`;
            unavailable.push({ code: m.code, label: m.label, reason });
          }
          const chosen = byCode.get(idx.code);
          if (chosen) paIndex = round2(chosen.pa);
        } else {
          for (const m of MATING_DISPLAY_TRAITS) {
            unavailable.push({
              code: m.code,
              label: m.label,
              reason: result.reason ?? "parent average could not be computed",
            });
          }
        }
      } else {
        for (const m of MATING_DISPLAY_TRAITS) {
          unavailable.push({
            code: m.code,
            label: m.label,
            reason: "trait detail not loaded for this bull — index projection only",
          });
        }
      }

      return {
        bullId: r.c.animalId,
        name: r.c.name,
        reg: ids?.reg ?? null,
        naab: ids?.naab ?? null,
        ownIndex: r.c.cols.get(idx.code) ?? null,
        paIndex: paIndex == null ? null : round2(paIndex),
        matchScore: r.matchScore,
        // Per selected trait: computeParentAverage's figure where it produced
        // one, and the pre-rank mean otherwise — the same precedence paIndex
        // has always used, applied to every column of the blend.
        traits: selected.map((s, i) => {
          const full = paByCode.get(s.code);
          const value = full ?? r.preValues[i];
          return {
            code: s.code,
            label: s.label,
            own: r.c.cols.get(s.code) ?? null,
            pa: value == null ? null : round2(value),
          };
        }),
        pa,
        unavailable,
        tier: r.tier,
        confidence: round2(r.confidence),
        bullSlots: r.bullSlots,
        reason: r.reason,
        blindSide: r.blindSide,
        // Indexed faults he improves (from the loop) plus the deep ones his full
        // record shows he improves — the "fixes …" badge.
        corrects: [...r.corrects, ...deepCorrectsFor(r.c.animalId)],
      };
    };

    // Split the cleared bulls by the deep floor before they become matches.
    const keptClear: Ranked[] = [];
    const deepSetback: MatingFemale["setback"] = [];
    for (const r of d.clear) {
      const reasons = deepReasonsFor(r.c.animalId);
      if (reasons.length) {
        const ids = bullIds.get(r.c.animalId);
        deepSetback.push({ bullId: r.c.animalId, name: r.c.name, reg: ids?.reg ?? null, naab: ids?.naab ?? null, reasons });
      } else {
        keptClear.push(r);
      }
    }
    // Fill reg/naab on the indexed set-asides where the bull happens to be on the
    // shortlist for some other female; otherwise they stay null (never loaded).
    const indexedSetback = d.setback.map((s) => {
      const ids = bullIds.get(s.bullId);
      return ids ? { ...s, reg: ids.reg, naab: ids.naab } : s;
    });
    const setbackAll = [...indexedSetback, ...deepSetback];
    const extraNotes = deepSetback.length
      ? [
          `${deepSetback.length} otherwise-recommended bull${deepSetback.length === 1 ? " was" : "s were"} set aside for a deep trait (Milking Speed / Bone Quality) — see “Set aside” below.`,
        ]
      : [];

    return {
      ...d.female,
      notes: [...d.female.notes, ...extraNotes],
      matches: keptClear.map(toMatch),
      unknown: d.unverified.map(toMatch),
      setback: opts.fullExclusions ? setbackAll : setbackAll.slice(0, EXCLUDED_DISPLAY_CAP),
      setbackTotal: setbackAll.length,
    };
  });

  // A run-wide banner when the pedigree parser has drifted: if more than half
  // the pasted females came back with nothing at all, the problem is the data
  // or the parser, not the cows.
  const blind = females.filter((f) => f.cowSlots === 0).length;
  if (females.length && blind > females.length / 2) {
    warnings.unshift(
      `${blind} of ${females.length} females returned NO pedigree at all. That is more than half the run — treat this report as broken and check the pedigree source before using any of it.`,
    );
  }

  // The report is "scored" — a Match score column is shown and the order is the
  // merit/correction blend — for any multi-trait blend, and for any run where at
  // least one female had a fault worth acting on. A single-trait run against a
  // herd of strong cows stays the classic raw-value report.
  const scored = multi || females.some((f) => f.weaknesses.some((w) => w.acted));

  return {
    females,
    params,
    scored,
    effectiveFloor,
    bullsConsidered: candidates.length,
    inactiveSuppressed,
    medianExclusionPct: round2(median(exclusionPcts)),
    keyResolveRate: entitySeen.size ? round2(entityResolved / entitySeen.size) : 0,
    generatedAt,
    warnings,
  };
}
