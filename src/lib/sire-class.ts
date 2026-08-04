// ---------------------------------------------------------------------------
// Sire classification — proven / genomic / active / inactive.
//
// The proven-vs-genomic split is NOT guesswork: it comes from Lactanet's own
// published file spec, "Bull Genetic Evaluation File Format"
// (https://lactanetgen.ca/evaluations/download.php?/layouts/BULL_PROOF_FILE_LAYOUT.pdf),
// reachable from Lactanet → Genetics → Genetic Evaluations → Data File Layouts.
//
// NOTE 2 of that spec defines CSV column 24, "PROOF ACTIVITY CODE and GENOTYPE
// INDICATOR". Codes 0–4 are the ungenotyped variants; 5–9 are the same states
// "and GENOTYPED", where the spec says "GENOTYPED INDICATES BREEDING VALUES
// INCLUDE GENOMIC INFORMATION". So the code carries two facts at once: whether
// the bull is proven, and whether his numbers include genomics.
//
// NOTE 11 defines the per-trait "OFFICIAL CODE" fields (LPI, PRODUCTION,
// CONFORMATION, …): 0 unofficial, 1 official, 2 parent average, 3 MACE.
//
// Verified against the real data: across all 626 imported CDN files (29,427
// rows), LPI OFFICIAL CODE 2 (parent average) = 25,278 rows with 0% daughters
// and average LPI reliability 76; code 1 (official) = 2,482 rows with 100%
// daughters and reliability 91; code 3 (MACE) = 210 rows, reliability 87.
// ---------------------------------------------------------------------------

// Type-only import: erased at compile time, so this module stays runtime-free of
// any dependency the Prisma maintenance scripts (plain tsx) cannot resolve.
import type { Prisma } from "@prisma/client";

/** Lactanet NOTE 2 — proof activity code + genotype indicator (CSV column 24). */
export const ACTIVITY_CODES: Record<string, { proven: boolean; genotyped: boolean; label: string }> = {
  "0": { proven: false, genotyped: false, label: "Not yet proven — may have official calving evaluation" },
  "1": { proven: true,  genotyped: false, label: "Newly proven" },
  "2": { proven: true,  genotyped: false, label: "Added daughters in first lactation in the last 12 months" },
  "3": { proven: true,  genotyped: false, label: "No additional first-lactation daughters in the last 12 months, or MACE proof" },
  "4": { proven: false, genotyped: false, label: "Unofficial LPI — official calving ability or daughter fertility only" },
  "5": { proven: false, genotyped: true,  label: "Not yet proven, genotyped" },
  "6": { proven: true,  genotyped: true,  label: "Newly proven, genotyped" },
  "7": { proven: true,  genotyped: true,  label: "Added daughters in first lactation in the last 12 months, genotyped" },
  "8": { proven: true,  genotyped: true,  label: "No additional first-lactation daughters in the last 12 months, genotyped" },
  "9": { proven: false, genotyped: true,  label: "Unofficial LPI — official calving ability or daughter fertility only, genotyped" },
};

/** Lactanet NOTE 11 — the per-trait OFFICIAL CODE fields. */
export const OFFICIAL_CODES: Record<string, string> = {
  "0": "Unofficial",
  "1": "Official",
  "2": "Parent average (GPA)",
  "3": "MACE (Interbull multi-country)",
};

/**
 * Classify one proof round as a proven or a genomic evaluation.
 *
 * Primary signal is the activity code, because Lactanet's own wording for it is
 * literally "NOT YET PROVEN" vs "NEWLY PROVEN". Where the code is missing (older
 * file layouts), fall back to the LPI official code — "official" (1) and "MACE"
 * (3) evaluations are daughter-based EBVs, "parent average" (2) is GPA-only —
 * and finally to a plain daughter count.
 */
export function classifyRound(input: {
  activityCode?: string | null;
  officialCode?: string | null;
  daughters?: number | null;
}): "proven" | "genomic" {
  const act = (input.activityCode ?? "").trim();
  const known = ACTIVITY_CODES[act];
  if (known) return known.proven ? "proven" : "genomic";

  const off = (input.officialCode ?? "").trim();
  if (off === "1" || off === "3") return "proven";
  if (off === "2") return "genomic";

  return (input.daughters ?? 0) > 0 ? "proven" : "genomic";
}

/** True when the activity code says the breeding values include genomic information. */
export function isGenotyped(activityCode?: string | null): boolean {
  return ACTIVITY_CODES[(activityCode ?? "").trim()]?.genotyped ?? false;
}

/** Human-readable Lactanet description for an activity code, for tooltips/profiles. */
export function activityLabel(activityCode?: string | null): string | null {
  return ACTIVITY_CODES[(activityCode ?? "").trim()]?.label ?? null;
}

/** Human-readable Lactanet description for an official code. */
export function officialLabel(officialCode?: string | null): string | null {
  return OFFICIAL_CODES[(officialCode ?? "").trim()] ?? null;
}

// --- Rollbacks -------------------------------------------------------------
// Lactanet re-bases (rolls back) the genetic base every April, so an April round
// is the one where a bull's numbers shift for reasons other than new data. Every
// other round carries updated information relative to that date.

// `isRollbackRound` now lives in src/lib/rollback.ts, next to the scoring that
// consumes it, so there is only one definition of "April round" in the app.

// --- The four sire roles the lineup lists filter by ------------------------
// proven/genomic and active/inactive are two independent axes, but the user-facing
// filter is one flat list of four, so each entry carries its own predicate.

export const SIRE_ROLES = [
  { code: "proven",   label: "Proven",   hint: "Has daughter-based EBVs (Lactanet: newly proven / added daughters / MACE)" },
  { code: "genomic",  label: "Genomic",  hint: "GPA genomics only — Lactanet: not yet proven" },
  { code: "active",   label: "Active",   hint: "Has a proof in the most recent round on file" },
  { code: "inactive", label: "Inactive", hint: "Latest proof predates the most recent round on file" },
] as const;

export type SireRole = (typeof SIRE_ROLES)[number]["code"];

export function isSireRole(v: string | null | undefined): v is SireRole {
  return !!v && SIRE_ROLES.some((r) => r.code === v);
}

/** Prisma `where` fragment for one of the four roles (null when the role is unknown). */
export function sireRoleWhere(role: string | null | undefined): Record<string, unknown> | null {
  switch (role) {
    case "proven": return { sireType: "proven" };
    case "genomic": return { sireType: "genomic" };
    case "active": return { proofStatus: "active" };
    case "inactive": return { proofStatus: "inactive" };
    default: return null;
  }
}

// --- Blondin house bulls ---------------------------------------------------
// Every animal that predates the Lactanet mass import is a Blondin stud bull.
// The marker is an AnimalRole row (roleType = "blondin") written once by
// prisma/tag-blondin-animals.ts — a role rather than a column, so it needs no
// migration, and because every importer only writes roles for animals it
// creates, no import can ever add, drop or duplicate it.

export const BLONDIN_ROLE = "blondin";

/**
 * Prisma `where` fragment for the Blondin toggle (null when the param is absent
 * or unrecognised, so the default view stays the whole population):
 *   "1" / "only"    — Blondin house bulls only
 *   "0" / "exclude" — everything except them, i.e. the wider Lactanet population
 */
export function blondinWhere(v: string | null | undefined): Prisma.AnimalWhereInput | null {
  switch (v) {
    case "1":
    case "only": return { roles: { some: { roleType: BLONDIN_ROLE, active: true } } };
    case "0":
    case "exclude": return { roles: { none: { roleType: BLONDIN_ROLE, active: true } } };
    default: return null;
  }
}

// --- Sorting shared by every lineup list -----------------------------------

export const SIRE_SORTS = [
  { code: "lpi",   label: "LPI",        kind: "eval" as const, col: "lpi" },
  { code: "conf",  label: "Conformation", kind: "eval" as const, col: "conf" },
  { code: "birth", label: "Birth date", kind: "animal" as const, col: "birthDate" },
  { code: "name",  label: "Name",       kind: "animal" as const, col: "primaryName" },
];

export function resolveSort(code: string | undefined | null) {
  return SIRE_SORTS.find((s) => s.code === (code ?? "").toLowerCase()) ?? null;
}
