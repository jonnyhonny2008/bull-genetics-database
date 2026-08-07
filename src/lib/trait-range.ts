// ---------------------------------------------------------------------------
// TRAIT RANGE FILTERS — "at least", "at most", "between", stacked.
//
// Replaces the Specialists finder on both animals lists. Specialists could only
// say one thing ("solidly positive for every picked trait"), which is a single
// preset of this: a floor on each trait. Ranges also express the two things it
// could never say —
//
//   * an upper bound (Stature at most +1), and
//   * a window around an intermediate optimum (Rump Angle between -0.5 and +1.0),
//
// and those are precisely the traits Specialists had to REFUSE to rank, because
// on an intermediate optimum there is no top of the list. So this closes a real
// gap rather than restating one in different words.
//
// THE URL FORMAT IS PERMANENT. SavedSearch stores a literal {path, query} and
// replays it as a link, so the first time anyone saves a view — or emails one,
// which is already a habit here — the format is locked. It is therefore written
// to be read by a human in a mail client, not to be compact:
//
//     ?f=LPI:3000..,CONF:..10,RUMP:-2..2
//        └ at least 3000  └ at most 10  └ between -2 and +2
//
// `..` is the separator rather than a dash so that a negative bound needs no
// escaping and no special case: "-2..2" and "..-1.5" both parse by splitting on
// the first "..", and a leading "-" is only ever a sign.
// ---------------------------------------------------------------------------

/** One trait's bound. At least one of min/max is set — a range with neither is
 *  not a filter and is dropped at parse time. */
export interface TraitRange {
  code: string;
  /** Inclusive lower bound (>=). Null means unbounded below. */
  min: number | null;
  /** Inclusive upper bound (<=). Null means unbounded above. */
  max: number | null;
}

/** The query-string key. One key holds every range so a saved view is one field. */
export const RANGE_PARAM = "f";

/**
 * Read the `f=` parameter.
 *
 * `allowed` is the set of codes the calling list can actually filter on, and it
 * is required rather than optional: a URL can carry anything, and a code with no
 * indexed column behind it would otherwise reach the query builder and either
 * throw or — worse — be silently ignored, which would show an UNFILTERED list
 * under a filter chip. Unknown codes are dropped here, once, and the caller
 * compares lengths if it wants to say so.
 */
export function parseTraitRanges(raw: string | undefined, allowed: Set<string>): TraitRange[] {
  return readTraitRanges(raw, allowed).ranges;
}

/**
 * The same parse, but also reporting the codes it THREW AWAY.
 *
 * A dropped code is not a harmless no-op. The list comes back unfiltered, and a
 * page that says nothing has just shown every bull in the database to somebody
 * who asked for a narrow set — the one failure mode where a filter tool actively
 * misleads instead of merely disappointing. Both animals lists render a notice
 * from `dropped`.
 *
 * It is a real scenario, not a defensive flourish: the American linear traits
 * have no indexed column yet (see us-cdcb/range-traits.ts), so a hand-built or
 * documented URL asking for one lands here.
 */
export function readTraitRanges(
  raw: string | undefined,
  allowed: Set<string>,
): { ranges: TraitRange[]; dropped: string[] } {
  if (!raw) return { ranges: [], dropped: [] };
  const out: TraitRange[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(",")) {
    const clause = part.trim();
    if (!clause) continue;
    const colon = clause.indexOf(":");
    if (colon < 1) continue;

    const code = clause.slice(0, colon).trim().toUpperCase();
    if (seen.has(code)) continue;
    if (!allowed.has(code)) {
      // Only report a code that asked for something. "STA:" is a typo, not a
      // trait this list cannot offer, and saying so would be noise.
      if (hasBound(clause.slice(colon + 1))) dropped.push(code);
      continue;
    }

    const spec = clause.slice(colon + 1).trim();
    const sep = spec.indexOf("..");
    // No "..' at all is read as a floor ("LPI:3000" means at least 3000). Typing
    // a bare number is the commonest thing a person does by hand, and reading it
    // as an exact-equality test on a float would match almost nothing.
    const lo = sep < 0 ? spec : spec.slice(0, sep);
    const hi = sep < 0 ? "" : spec.slice(sep + 2);

    const min = num(lo);
    const max = num(hi);
    if (min == null && max == null) continue;

    seen.add(code);
    out.push({ code, min, max });
  }
  return { ranges: out, dropped };
}

/** True when a clause's range half carries at least one parseable bound. */
function hasBound(spec: string): boolean {
  const s = spec.trim();
  const sep = s.indexOf("..");
  return sep < 0 ? num(s) != null : num(s.slice(0, sep)) != null || num(s.slice(sep + 2)) != null;
}

/** Back to the `f=` value. Round-trips parseTraitRanges exactly. */
export function serialiseTraitRanges(ranges: TraitRange[]): string {
  return ranges
    .filter((r) => r.min != null || r.max != null)
    .map((r) => `${r.code}:${r.min ?? ""}..${r.max ?? ""}`)
    .join(",");
}

/**
 * One range in words, for a filter chip.
 *
 * `fmt` renders a bound in the trait's own units, so a Net Merit bound reads
 * "$500" and a Milk bound reads "+600 lb" — the same formatter the table uses,
 * because a chip that disagrees with the column beneath it is worse than no chip.
 */
export function describeTraitRange(r: TraitRange, fmt: (v: number) => string): string {
  if (r.min != null && r.max != null) return `${fmt(r.min)} to ${fmt(r.max)}`;
  if (r.min != null) return `≥ ${fmt(r.min)}`;
  return `≤ ${fmt(r.max as number)}`;
}

/**
 * True when a range can never match, because the floor sits above the ceiling.
 *
 * Deliberately NOT repaired by swapping the two. The pickers have separate min
 * and max boxes, so this only arises from a hand-edited URL, and silently
 * reinterpreting what someone typed is how a filter comes to show results that
 * do not match the chip describing it. The list says so instead.
 */
export function isImpossibleRange(r: TraitRange): boolean {
  return r.min != null && r.max != null && r.min > r.max;
}

/** A Prisma numeric filter for one column. Both bounds are inclusive. */
export function rangeFilter(r: TraitRange): { gte?: number; lte?: number } {
  const f: { gte?: number; lte?: number } = {};
  if (r.min != null) f.gte = r.min;
  if (r.max != null) f.lte = r.max;
  return f;
}

/** Strict numeric parse. "" / "abc" / "NaN" / "Infinity" are all "no bound",
 *  never 0 — a bound of zero is a real and very different filter. */
function num(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
