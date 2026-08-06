// ---------------------------------------------------------------------------
// Linking CDCB animals to the animals this app already holds.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. The "Blondin bull" flag is an AnimalRole
// row on the Animal, not a field on an evaluation — so if the US importer
// resolves to the EXISTING Animal, the flag, favourites, pedigree links and notes
// all come along for free with no new code. The corollary is the risk: every
// FAILED link silently creates an unflagged duplicate bull. That makes this
// transform load-bearing for the whole feature.
//
// THE TRANSFORM
//   CDCB id17 = 2-char registry breed + 3-char country + 12-char right-aligned
//               zero-padded herdbook number. Sex is NOT encoded (it is a separate
//               field).
//   This app stores Canadian registrations as breed(2) + country(3) + SEX(1) +
//               unpadded number.
//
//     HOCANM13486161   -> HOCAN000013486161   (AIJA BELIEVE-P, 799HO00030)
//     HO840M3134506807 -> HO840003134506807   (SIEMERS APPLES ARMY-ET, 799HO00003)
//
// Verified end to end: all 299 registrations in Blondin's April-2026 Lactanet
// file joined against the 68,017-ID April-2026 CDCB union produced 69 links, and
// of the 65 comparable, the registered name matched 65/65 with 0 disagreements.
//
// THREE VERIFIED FAILURE MODES — each is why this returns CANDIDATES with a
// confidence rather than a single confident answer:
//
//   1. LETTERS IN THE HERDBOOK NUMBER. Lactanet stores an Australian sire as
//      HOAUSM1993596 while CDCB has HOAUS0000H01993596 — the real number is
//      H01993596 and Lactanet dropped the leading letters. That information is
//      GONE on our side, so no transform can recover it. 1,189 CDCB IDs have a
//      non-numeric tail. Exposure where we care: CAN 1 of 8,424, 840 0 of 12,832,
//      USA 49 of 29,639.
//   2. CANADA IS SOMETIMES `124`, NOT `CAN`. 13 Progenesis Jerseys sit under
//      JE124... with no JECAN form at all.
//   3. USA/840 DUALITY. 29,639 IDs use USA and 12,832 use 840, and CDCB's own
//      crossref pairs them with identical digits.
//
// So the country segment is treated as an equivalence set and every variant is
// tried. Outside the known sets the padded form is a CANDIDATE ONLY and needs a
// second signal before it may be linked.
//
// NAAB IS NEVER AN IDENTITY KEY. CDCB's NAAB_CODE is byte-identical to the form
// this app stores, unique within a round, and showed zero reassignment in every
// window we could test — but those windows are far too short to disprove reuse,
// and src/lib/proof-import.ts documents at length why matching on a recycled NAAB
// grafts a new bull's proof onto the last holder. Use it to CONFIRM a link and to
// flag disagreements for review; never to make one.
// ---------------------------------------------------------------------------

/** Country segments that mean the same country. */
const COUNTRY_EQUIVALENTS: Record<string, string[]> = {
  CAN: ["CAN", "124"],
  "124": ["124", "CAN"],
  USA: ["USA", "840"],
  "840": ["840", "USA"],
};

/**
 * Countries where the zero-pad is known to be information-preserving, so the
 * transform can be trusted on its own. Everywhere else the herdbook number may
 * carry letters our side has already dropped.
 */
const TRUSTED_COUNTRIES = new Set(["CAN", "124", "USA", "840"]);

export interface CaRegParts {
  breed: string;
  country: string;
  sex: "M" | "F";
  /** Everything after the sex character, exactly as stored. */
  number: string;
}

/**
 * Split a registration as this app stores it. Uppercases and trims first —
 * src/lib/lactanet.ts only trims, so mixed case does reach the database.
 *
 * The number segment deliberately allows letters: some registries use them, and
 * we need to SEE that case in order to refuse it (see failure mode 1).
 */
export function parseCaReg(reg: string): CaRegParts | null {
  const s = (reg ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = /^([A-Z]{2})([A-Z0-9]{3})([MF])([A-Z0-9]+)$/.exec(s);
  if (!m) return null;
  return { breed: m[1], country: m[2], sex: m[3] as "M" | "F", number: m[4] };
}

/** Split a CDCB id17 into its parts. */
export function parseId17(id17: string): { breed: string; country: string; number: string } | null {
  const s = (id17 ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = /^([A-Z]{2})([A-Z0-9]{3})([A-Z0-9]{12})$/.exec(s);
  if (!m) return null;
  return { breed: m[1], country: m[2], number: m[3] };
}

export type LinkConfidence =
  /** The pad is information-preserving for this country — safe to link on alone. */
  | "deterministic"
  /** Shape is right but the country is outside the trusted set, or our number may
   *  have had letters stripped. Requires a second signal (name or NAAB). */
  | "candidate";

export interface Id17Candidate {
  id17: string;
  confidence: LinkConfidence;
  /** Why it is only a candidate, for the review queue. */
  caveat?: string;
}

/**
 * Every id17 a stored registration could correspond to, best first.
 *
 * Returns a LIST because the country segment has variants ({CAN,124},{USA,840})
 * and because CDCB may hold the animal under either. Callers should try them in
 * order and stop at the first hit.
 */
export function caRegToId17Candidates(reg: string): Id17Candidate[] {
  const p = parseCaReg(reg);
  if (!p) return [];
  if (p.number.length > 12) return [];

  const countries = COUNTRY_EQUIVALENTS[p.country] ?? [p.country];
  const numberHasLetters = /[A-Z]/.test(p.number);

  return countries.map((country) => {
    const id17 = `${p.breed}${country}${p.number.padStart(12, "0")}`;
    if (!TRUSTED_COUNTRIES.has(country)) {
      return {
        id17, confidence: "candidate" as const,
        caveat: `country "${country}" is outside the set where the zero-pad is known to be information-preserving; confirm by name or NAAB before linking`,
      };
    }
    if (numberHasLetters) {
      return {
        id17, confidence: "candidate" as const,
        caveat: "the herdbook number contains letters, which some registries position differently; confirm before linking",
      };
    }
    return { id17, confidence: "deterministic" as const };
  });
}

/** The single best id17 for a registration, or null. Prefer the candidate list
 *  when you can try more than one. */
export function caRegToId17(reg: string): string | null {
  return caRegToId17Candidates(reg)[0]?.id17 ?? null;
}

/**
 * Rebuild a stored-style registration from a CDCB id17.
 *
 * Sex must be supplied because id17 does not encode it — read `SEX` from the
 * animal's infoANIM block. Leading zeros are stripped, which is safe: no
 * registration in the 299-bull sample had a meaningful leading zero.
 */
export function id17ToCaReg(id17: string, sex: "M" | "F"): string | null {
  const p = parseId17(id17);
  if (!p) return null;
  const number = p.number.replace(/^0+/, "") || "0";
  return `${p.breed}${p.country}${sex}${number}`;
}

/** True when two registrations refer to the same animal allowing for the
 *  country-segment variants. */
export function sameRegistration(a: string, b: string): boolean {
  const pa = parseCaReg(a), pb = parseCaReg(b);
  if (!pa || !pb) return false;
  if (pa.breed !== pb.breed || pa.sex !== pb.sex) return false;
  if (pa.number.replace(/^0+/, "") !== pb.number.replace(/^0+/, "")) return false;
  const set = COUNTRY_EQUIVALENTS[pa.country] ?? [pa.country];
  return set.includes(pb.country);
}

// --- NAAB --------------------------------------------------------------------

/**
 * Canonical NAAB form: a 3-digit stud prefix, the breed code, then a 5-digit
 * suffix — e.g. `007HO16276`.
 *
 * This matters more than it sounds. CDCB zero-pads (`007HO16276`) while Holstein
 * Association publishes unpadded (`7HO16276`), and joining the two naively loses
 * roughly half the matches — measured: 53 of 99 on a real top-100 list.
 */
export function normalizeNaab(code: string | null | undefined): string | null {
  const s = (code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^(\d{1,3})([A-Z]{2})(\d{1,5})$/.exec(s);
  if (!m) return null;
  return `${m[1].padStart(3, "0")}${m[2]}${m[3].padStart(5, "0")}`;
}

/** True when two NAAB codes are the same code written differently. */
export function sameNaab(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeNaab(a), nb = normalizeNaab(b);
  return na !== null && na === nb;
}

// --- link outcome ------------------------------------------------------------

export interface LinkCheck {
  linked: boolean;
  confidence: LinkConfidence | null;
  /** Set when the identifiers agreed but a second signal disagreed — route these
   *  to the review queue rather than importing them. */
  conflict?: string;
}

/**
 * Decide whether a CDCB record may attach to an existing Animal.
 *
 * `confirmations` are the second signals: the app's stored name and NAAB versus
 * CDCB's. A deterministic id17 match links on its own; a candidate match needs at
 * least one confirmation. A NAAB that actively DISAGREES blocks the link outright
 * — that is the recycled-code hazard, and importing through it would overwrite a
 * different bull's identity.
 */
export function assessLink(
  candidate: Id17Candidate,
  confirmations: { storedName?: string | null; cdcbName?: string | null; storedNaab?: string | null; cdcbNaab?: string | null },
): LinkCheck {
  const { storedName, cdcbName, storedNaab, cdcbNaab } = confirmations;

  if (storedNaab && cdcbNaab && !sameNaab(storedNaab, cdcbNaab)) {
    return {
      linked: false, confidence: candidate.confidence,
      conflict: `NAAB disagrees: this app holds ${storedNaab}, CDCB reports ${cdcbNaab}. NAAB codes are reused between bulls, so this may be two different animals.`,
    };
  }

  const nameAgrees = !!storedName && !!cdcbName && normalizeName(storedName) === normalizeName(cdcbName);
  const naabAgrees = sameNaab(storedNaab, cdcbNaab);

  if (candidate.confidence === "deterministic") return { linked: true, confidence: "deterministic" };
  if (nameAgrees || naabAgrees) return { linked: true, confidence: "candidate" };
  return {
    linked: false, confidence: "candidate",
    conflict: candidate.caveat ?? "candidate match with no confirming name or NAAB",
  };
}

/** Registered names vary in punctuation and spacing between registries. */
function normalizeName(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
