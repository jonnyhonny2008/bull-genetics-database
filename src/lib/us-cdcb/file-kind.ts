// ---------------------------------------------------------------------------
// Which CDCB extract is this file, and is the evaluation it carries an official
// triannual round or a between-round add?
//
// THE FILE-FAMILY TOKEN IN THE NAME IS THE ONLY THING THAT DECIDES. Two other
// signals look authoritative and are not:
//
//   * The in-file `RUN:` field takes only "weekly" and "monthly". The April 2026
//     OFFICIAL round reads `RUN:monthly` — identical to a between-round add.
//   * The `DATE:` month does not separate them either:
//       HO_New_young_Pub_infoANIM_2604.csv -> #TYPE:ANIM|RUN:monthly|DATE:2604|...
//     is a monthly ADD whose month is also 04. Cross-checking the month buys
//     nothing eight months a year and gives false confidence the other four.
//
// This is the mirror image of the Canadian problem: there, official-vs-interim
// survives ONLY in the file name (see src/lib/proof-file-kind.ts). Here the name
// is also the answer, but for a different reason — and the grammar is far simpler
// because CDCB ships ONE file per round. There is no official/interim pair.
//
// Families, verified against the real CDCB FTP listing (webconnect.uscdcb.com):
//
//   {BREED}_all_evaluated_{YYMM}      TRIANNUAL — reference/daughter-proven bulls
//   {BREED}_young_Pub_{YYMM}          TRIANNUAL — genomic bulls, same evaluation
//   {BREED}_New_young_Pub_{YYMM}      MONTHLY   — animals genotyped since last month
//   {BREED}_young_Pub_{YYYYMMDD}      WEEKLY    — animals genotyped that week
//
// The two triannual families are near-disjoint slices of ONE evaluation: of the
// 60 Ayrshire ids present in both for 2604, every trait value is byte-identical.
// So they union without conflict resolution.
//
// The between-round families are pure ADDS (verified: zero id overlap with the
// prior round) and their values are PROVISIONAL — every Ayrshire bull first
// published in Feb 2026 had a different GPTA by the April round. They must be
// tagged so a proof-change report never reads the provisional→official jump as
// genetic movement.
// ---------------------------------------------------------------------------

/** Which CDCB extract a file belongs to. */
export type CdcbFamily = "all_evaluated" | "young_pub" | "new_young" | "weekly";

/**
 * How the evaluation should be labelled.
 *   official    — a triannual round (April / August / December)
 *   provisional — a monthly add; real but superseded at the next round
 *   unofficial  — a weekly add; CDCB stamps these animals CURRENT=U
 */
export type CdcbRunKind = "official" | "provisional" | "unofficial";

export interface CdcbFileId {
  family: CdcbFamily | null;
  kind: CdcbRunKind | null;
  /** Breed code from the name, upper-cased: HO JE BS GU AY. */
  breed: string | null;
  /** Round code YYMM — SET ONLY for the triannual families. */
  roundCode: string | null;
  /**
   * Unique period identity, always set. Prefixed so a monthly add can never
   * collide with the official round of the same month:
   *   R2604  triannual round     M2604  monthly add     W20260802  weekly add
   * `New_young_Pub_2604` and `all_evaluated_2604` share a YYMM but not a period.
   */
  periodKey: string | null;
  /** The date exactly as it appears in the name: YYMM or YYYYMMDD. */
  date: string | null;
}

const BREEDS = ["HO", "JE", "BS", "GU", "AY"];

/** CDCB breeds that publish bull evaluation files. */
export const CDCB_BREEDS = [...BREEDS];

const EMPTY: CdcbFileId = { family: null, kind: null, breed: null, roundCode: null, periodKey: null, date: null };

/**
 * Classify a CDCB file by name. Accepts the zip name or either member CSV —
 * `AY_all_evaluated_2604.zip`, `AY_all_evaluated_infoEVAL_2604.csv` and the
 * transposed `AY_all_evaluated_2604_wide.csv` all classify identically, so the
 * importer can key off whichever it is handed.
 *
 * Any leading path is discarded, and the match is case-insensitive.
 */
export function classifyCdcbFile(fileName: string): CdcbFileId {
  const name = (fileName ?? "").trim().replace(/\\/g, "/").split("/").pop() ?? "";
  if (!name) return { ...EMPTY };
  const lower = name.toLowerCase();

  // Breed is the leading token. Anchored: a bare "ho" elsewhere in the name
  // (e.g. a hand-added "_holdback") must not be read as Holstein.
  const breedM = /^([a-z]{2})_/.exec(lower);
  const breed = breedM && BREEDS.includes(breedM[1].toUpperCase()) ? breedM[1].toUpperCase() : null;
  if (!breed) return { ...EMPTY };

  // The date is the last run of digits before the extension: YYMM or YYYYMMDD.
  // Taking the LAST occurrence matters — "AY_all_evaluated_infoEVAL_2604.csv"
  // has only one, but a hash-prefixed or doubled name would carry more.
  let date: string | null = null;
  const dateRe = /(\d{8}|\d{4})(?=[^0-9]*$)/g;
  for (let m = dateRe.exec(lower); m; m = dateRe.exec(lower)) date = m[1];

  // ORDER MATTERS: "new_young_pub" contains "young_pub", so it is tested first.
  let family: CdcbFamily | null = null;
  if (/new_young_pub/.test(lower)) family = "new_young";
  else if (/all_evaluated/.test(lower)) family = "all_evaluated";
  else if (/young_pub/.test(lower)) family = date && date.length === 8 ? "weekly" : "young_pub";
  if (!family) return { ...EMPTY, breed };

  // A weekly file must carry a full date; a triannual/monthly one a YYMM. A
  // mismatch means the name is not the shape we think it is — refuse it rather
  // than guess, because guessing wrong files a provisional add as an official round.
  if (family === "weekly" && (!date || date.length !== 8)) return { ...EMPTY, breed };
  if (family !== "weekly" && (!date || date.length !== 4)) return { ...EMPTY, breed };

  const kind: CdcbRunKind =
    family === "weekly" ? "unofficial" : family === "new_young" ? "provisional" : "official";

  const isTriannual = family === "all_evaluated" || family === "young_pub";
  return {
    family,
    kind,
    breed,
    roundCode: isTriannual ? date : null,
    periodKey: isTriannual ? `R${date}` : family === "new_young" ? `M${date}` : `W${date}`,
    date,
  };
}

/** True when the file carries an evaluation we store. */
export function isImportableCdcbFile(id: CdcbFileId): boolean {
  return id.family !== null && id.kind !== null;
}

/**
 * The evaluation date for a round.
 *
 * Triannual and monthly files carry YYMM and are dated to the 1st of that month
 * in UTC, matching how the Canadian side dates a GERUN round. A weekly file
 * carries its own YYYYMMDD publication date.
 */
export function cdcbRoundDate(id: CdcbFileId): Date | null {
  if (!id.date) return null;
  if (id.date.length === 8) {
    const y = +id.date.slice(0, 4), mo = +id.date.slice(4, 6), d = +id.date.slice(6, 8);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const yy = +id.date.slice(0, 2), mm = +id.date.slice(2, 4);
  if (mm < 1 || mm > 12) return null;
  return new Date(Date.UTC(2000 + yy, mm - 1, 1));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Human label for a round, e.g. "April 2026" or "Week of 2 Aug 2026". */
export function cdcbRoundLabel(id: CdcbFileId): string | null {
  const d = cdcbRoundDate(id);
  if (!d) return null;
  if (id.date?.length === 8) return `Week of ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Human label for the run kind, for the UI. */
export function cdcbRunKindLabel(kind: CdcbRunKind | null | undefined): string {
  return kind === "official" ? "Official" : kind === "provisional" ? "Provisional" : kind === "unofficial" ? "Unofficial" : "Unknown";
}
