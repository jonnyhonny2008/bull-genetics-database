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

/**
 * The indexes a mating run may be ranked on.
 *
 * PI and F&L are DELIBERATELY ABSENT. Only about half of the preferred
 * evaluations carry them, so ranking on either would silently drop half the
 * lineup — the user would see a shorter list and no explanation.
 */
export const MATING_INDEXES: { code: string; label: string; col: string }[] = [
  { code: "LPI", label: "LPI", col: "lpi" },
  { code: "PRO$", label: "Pro$", col: "proDollar" },
  { code: "CONF", label: "Conformation", col: "conf" },
  { code: "MAMM", label: "Mammary", col: "mamm" },
  { code: "MILK", label: "Milk", col: "milk" },
  { code: "FAT", label: "Fat", col: "fat" },
  { code: "PROT", label: "Protein", col: "prot" },
  { code: "SCS", label: "SCS", col: "scs" },
];

/**
 * Indexes where a LOWER number is the better animal. Somatic Cell Score is the
 * only one on the menu. Ranking it descending — as a naive "highest index wins"
 * would — recommends the worst udder-health bulls in the barn, so the sort
 * direction is derived, never assumed. Kept private so MATING_INDEXES keeps the
 * exact shape the page and the export consume.
 */
const LOWER_IS_BETTER = new Set(["SCS"]);

const DEFAULT_INDEX = "LPI";
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
  index: string;
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
}

export interface MatingReport {
  females: MatingFemale[];
  params: MatingParams;
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

  const idx = MATING_INDEXES.find((i) => i.code === (sp.index ?? "").trim().toUpperCase());
  if (sp.index && !idx) {
    warnings.push(`"${sp.index}" is not a rankable index in this build — ranked on ${DEFAULT_INDEX} instead.`);
  }
  const index = idx?.code ?? DEFAULT_INDEX;

  const nRaw = Number.parseInt(sp.topN ?? "", 10);
  const topN = Number.isFinite(nRaw) ? Math.min(Math.max(nRaw, 1), MAX_TOP_N) : DEFAULT_TOP_N;

  const gRaw = (sp.maxGen ?? "").trim();
  const maxGen: 0 | 2 | 3 = gRaw === "0" || gRaw === "off" ? 0 : gRaw === "2" ? 2 : 3;

  let pool: MatingParams["pool"] = "blondin";
  const poolRaw = (sp.pool ?? "").trim().toLowerCase();
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
    params: { females, index, topN, maxGen, pool, includeInactive, floor },
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
  /** Indexed column values, keyed by MATING_INDEXES code. */
  cols: Map<string, number | null>;
}

/**
 * The pool filter that can be pushed into SQL. The "active" restriction is
 * DELIBERATELY not here: it is applied in memory below so that
 * `inactiveSuppressed` is an exact count of what was withheld rather than a
 * silent absence.
 */
function poolWhere(pool: MatingParams["pool"]): Prisma.AnimalWhereInput {
  if (pool === "blondin") return blondinWhere("1") ?? {};
  return {};
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

  const idx = MATING_INDEXES.find((i) => i.code === params.index)!;
  const higherIsBetter = !LOWER_IS_BETTER.has(idx.code);
  if (!higherIsBetter) {
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
  const orderBy = {
    [idx.col]: { sort: higherIsBetter ? "desc" : "asc", nulls: "last" },
  } as unknown as Prisma.GeneticEvaluationOrderByWithRelationInput;

  const candidateRowsPromise = prisma.geneticEvaluation.findMany({
    where: {
      isPreferred: true,
      animal: { archived: false, sex: "M", ...poolWhere(params.pool) },
    },
    select: {
      animalId: true,
      lpi: true,
      proDollar: true,
      conf: true,
      mamm: true,
      milk: true,
      fat: true,
      prot: true,
      scs: true,
      animal: { select: { primaryName: true, proofStatus: true, sireType: true } },
    },
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

  const [candidateRows, internalRows, defMap] = await Promise.all([
    candidateRowsPromise,
    internalRowsPromise,
    defMapPromise,
  ]);

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
      cols: new Map<string, number | null>([
        ["LPI", r.lpi],
        ["PRO$", r.proDollar],
        ["CONF", r.conf],
        ["MAMM", r.mamm],
        ["MILK", r.milk],
        ["FAT", r.fat],
        ["PROT", r.prot],
        ["SCS", r.scs],
      ]),
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

  // A bull with no value for the chosen index cannot be ranked on it. Dropping
  // him is stated, not silent.
  const indexMissing = candidates.filter((c) => c.cols.get(idx.code) == null).length;
  if (indexMissing) {
    candidates = candidates.filter((c) => c.cols.get(idx.code) != null);
    warnings.push(`${indexMissing} bull${indexMissing === 1 ? " has" : "s have"} no ${idx.label} on the preferred proof and could not be ranked.`);
  }

  if (candidates.length === 0) {
    warnings.push(`No bull in the "${params.pool}" pool has a rankable ${idx.label} — nothing could be recommended.`);
  }

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
    pre: number | null;
    reason: string;
    blindSide: MatingMatch["blindSide"];
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

  interface Draft {
    female: MatingFemale;
    parent: PAParent | null;
    clear: Ranked[];
    unverified: Ranked[];
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
      excluded: [],
      excludedTotal: 0,
      notes,
      paBasis: "pa",
      indexLabel: idx.label,
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
      });
      continue;
    }
    if (degraded) notes.push(darkBranchNote(cowSet) ?? "Pedigree too thin to screen.");

    const damIndex = parent.traits.get(idx.code)?.value ?? null;
    if (damIndex == null) {
      base.paBasis = "bull-index";
      base.indexLabel = `Bull index — dam has no ${idx.label}`;
      notes.push(
        `${base.name ?? base.reg} has no ${idx.label}, so no parent average could be computed for it — the ranking below is the BULL'S OWN ${idx.label}, not a projection for the calf.`,
      );
    }

    const clear: Ranked[] = [];
    const unverified: Ranked[] = [];
    const excluded: MatingFemale["excluded"] = [];

    for (const c of candidates) {
      const bullSet = bullSets.get(c.animalId)!;
      const own = c.cols.get(idx.code) ?? null;
      const pre = own == null ? null : damIndex == null ? own : (own + damIndex) / 2;

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
          reason: "Audit mode — no relatedness screening was performed on this pair.",
          blindSide: null,
        });
        continue;
      }

      const v = assessRelatedness(cowSet, bullSet, { maxGen: params.maxGen, floor: params.floor });
      if (v.tier === "excluded") {
        excluded.push({ bullId: c.animalId, name: c.name, shared: v.shared });
      } else if (v.tier === "clear") {
        clear.push({
          c, tier: "clear", confidence: v.confidence, bullSlots: v.bullSlots, pre,
          reason: "", blindSide: null,
        });
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
          ...whyUnverified(cowSet, bullSet, cowLabel),
        });
      }
    }

    const byPre = (a: Ranked, b: Ranked) => {
      if (a.pre == null && b.pre == null) return a.c.name.localeCompare(b.c.name);
      if (a.pre == null) return 1;
      if (b.pre == null) return -1;
      return higherIsBetter ? b.pre - a.pre : a.pre - b.pre;
    };
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
      female: { ...base, excluded: shownExcluded, excludedTotal: excluded.length, notes },
      parent,
      clear: clear.slice(0, params.topN),
      unverified: shownUnknown,
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
    const toMatch = (r: Ranked): MatingMatch => {
      const ids = bullIds.get(r.c.animalId);
      const bullParent = bullParents.get(r.c.animalId);
      const pa: MatingMatch["pa"] = [];
      const unavailable: MatingMatch["unavailable"] = [];
      let paIndex = r.pre;

      if (bullParent && d.parent) {
        // computeParentAverage, unchanged and unforked. The displayed numbers
        // are ITS numbers, not the pre-rank's.
        const result = computeParentAverage(bullParent, d.parent);
        if (result.ok) {
          const byCode = new Map(result.pa.map((row) => [row.code, row]));
          const unavByCode = new Map(result.unavailable.map((u) => [u.code, u]));
          for (const m of MATING_INDEXES) {
            const row = byCode.get(m.code);
            if (row) {
              pa.push({ code: m.code, label: m.label, value: row.pa });
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
          for (const m of MATING_INDEXES) {
            unavailable.push({
              code: m.code,
              label: m.label,
              reason: result.reason ?? "parent average could not be computed",
            });
          }
        }
      } else {
        for (const m of MATING_INDEXES) {
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
        pa,
        unavailable,
        tier: r.tier,
        confidence: round2(r.confidence),
        bullSlots: r.bullSlots,
        reason: r.reason,
        blindSide: r.blindSide,
      };
    };

    return {
      ...d.female,
      matches: d.clear.map(toMatch),
      unknown: d.unverified.map(toMatch),
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

  return {
    females,
    params,
    effectiveFloor,
    bullsConsidered: candidates.length,
    inactiveSuppressed,
    medianExclusionPct: round2(median(exclusionPcts)),
    keyResolveRate: entitySeen.size ? round2(entityResolved / entitySeen.size) : 0,
    generatedAt,
    warnings,
  };
}
