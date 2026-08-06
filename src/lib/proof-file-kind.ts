// ---------------------------------------------------------------------------
// Which Lactanet extract is this file, and is the proof round it carries
// OFFICIAL or INTERIM?
//
// Lactanet ships a stud's "GE All Traits" extract as more than one file per
// run, and the distinction is carried ONLY by the file name. It is not
// recoverable from the rows: for April 2025 the official and unofficial files
// both stamp GERUN 2504, both mark BLONDIN ZIMMER CAPTURE with LPI OFFICIAL
// CODE 1, and yet his LPI is 2249 in one and 2241 in the other. 82 of the 137
// shared bulls differ that way. So the name is the only provenance there is,
// and it has to be captured at import time or it is gone for good.
//
// The families, verified against the 1,139 CSVs under
// "Blondin Sires - Genetics":
//
//   gealltraits_bulls_unoff<stud><YYMM>[_<YYYYMMDD>]_<breed>  INTERIM
//   gealltraits_bulls<stud><YYMM>[_<YYYYMMDD>]_<breed>        OFFICIAL
//   <stud><YYMM>[_<YYYYMMDD>]_<breed>                         INTERIM  (see below)
//   <stud><YYMM>pregeno[_<YYYYMMDD>]_<breed>                  PRE-GENOMIC
//   gealltraits_cows<stud><YYMM>_<breed>                      cows, not a bull round
//   gealltraits_bulls_priv<YYMM>_<breed>                      other studs' bulls
//
// The bare "<stud><YYMM>" family is the same run as the _unoff file, not a
// third thing: for both 2504 and 2604 the bare file and the _unoff file hold
// an identical set of registrations with zero differing LPI values. It is the
// 274-column layout of the same extract, while _unoff is the 277-column one.
// Treating it as official would misfile 310 files.
//
// "pregeno" is genuinely separate — EVERY LPI differs from both the official
// and the unofficial file for the same GERUN, because it is the evaluation
// computed without genomic information. It is not a proof round and must not
// be imported as one.
// ---------------------------------------------------------------------------

/** How a stored evaluation should be labelled. */
export type ProofRunKind = "official" | "interim";

/** Which Lactanet extract a file is. */
export type ProofFileFamily =
  | "official"
  | "interim"
  | "pregenomic"
  | "private"
  | "cows"
  | "other";

export interface ProofFileId {
  family: ProofFileFamily;
  /** The run kind to store, or null when the file is not a stud bull round. */
  kind: ProofRunKind | null;
  /** Stud code, e.g. "0799" (Blondin). Null for files that carry none. */
  stud: string | null;
  /** GERUN as YYMM, e.g. "2504". */
  gerun: string | null;
  /** Release date stamped in the name as YYYYMMDD, when present. */
  releaseDate: string | null;
  /** Breed suffix, upper-cased, e.g. "HO". */
  breed: string | null;
}

const BREEDS = ["ho", "je", "ay", "bs", "gu", "cn", "ca", "ms", "rw"];
// The breed code may be followed by hand-added junk before the extension —
// "_ho 2.csv" from a duplicate download, "_ho-Edit.csv", "_ho-Dann's MacBook
// Pro.csv". Requiring a non-alphanumeric before that junk keeps "_hoxx.csv"
// from being read as Holstein.
const BREED_RE = new RegExp(`_(${BREEDS.join("|")})(?:[^a-z0-9][^.]*)?\\.csv$`, "i");

/**
 * Markers are searched for ANYWHERE in the name, not anchored to the start.
 *
 * Two real-world shapes make anchoring wrong. The staging step prefixed files
 * with a content hash ("012d2bbf_07992404_20240409_ho.csv") and in other cases
 * concatenated the containing folder onto the basename
 * ("07992006_20200602_07992006_20200602_ho.csv"). Anchored patterns drop both
 * on the floor as "other" — which is exactly how 310 interim files came to be
 * imported as ordinary rounds.
 *
 * Order matters. "priv" and "cows" are tested before the bulls patterns because
 * "gealltraits_bulls_priv2504_ho.csv" contains "gealltraits_bulls", and _unoff
 * is tested before official for the same reason.
 */
export function classifyProofFile(fileName: string): ProofFileId {
  const name = (fileName ?? "").trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = name.toLowerCase();

  const breedM = BREED_RE.exec(lower);
  const breed = breedM ? breedM[1].toUpperCase() : null;

  // Stud + GERUN, e.g. "07992504". Take the LAST occurrence: on a doubled name
  // both halves carry it, and the trailing one is the file's own.
  let stud: string | null = null;
  let gerun: string | null = null;
  const studRe = /(\d{4})(\d{2}(?:0[1-9]|1[0-2]))/g;
  for (let m = studRe.exec(lower); m; m = studRe.exec(lower)) {
    // Reject an 8-digit release date (YYYYMMDD) masquerading as stud+GERUN:
    // a real run starts 20xx/19xx only as a date, never as a stud code.
    if (/^(19|20)\d{2}$/.test(m[1])) continue;
    stud = m[1];
    gerun = m[2];
  }

  // Release date: a standalone YYYYMMDD run.
  const relM = lower.match(/(?:^|[^\d])((?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?:[^\d]|$)/);
  const releaseDate = relM ? relM[1] : null;

  const base: Omit<ProofFileId, "family" | "kind"> = { stud, gerun, releaseDate, breed };

  if (/priv/.test(lower)) {
    // Private files carry a bare YYMM and no stud code.
    const pm = lower.match(/priv(\d{2}(?:0[1-9]|1[0-2]))/);
    return { ...base, stud: null, gerun: pm ? pm[1] : base.gerun, family: "private", kind: null };
  }
  if (/gealltraits_cows/.test(lower)) return { ...base, family: "cows", kind: null };
  if (/pregeno/.test(lower)) return { ...base, family: "pregenomic", kind: null };
  if (/gealltraits_bulls_unoff/.test(lower)) return { ...base, family: "interim", kind: "interim" };
  if (/gealltraits_bulls/.test(lower)) return { ...base, family: "official", kind: "official" };
  // Bare <stud><YYMM> — content-identical to the _unoff extract.
  if (stud && gerun) return { ...base, family: "interim", kind: "interim" };

  return { ...base, family: "other", kind: null };
}

/** True when the file holds bull proof rows we store as a dated round. */
export function isImportableProofFile(id: ProofFileId): boolean {
  return id.kind !== null;
}

/** Human label for the UI. */
export function runKindLabel(kind: ProofRunKind | null | undefined): string {
  return kind === "interim" ? "Interim" : kind === "official" ? "Official" : "Unknown";
}

/** Parse the "YYYYMMDD" release date from classifyProofFile().releaseDate to a Date. */
export function parseReleaseDate(s: string | null | undefined): Date | null {
  if (!s || !/^\d{8}$/.test(s)) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}
