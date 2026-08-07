// ---------------------------------------------------------------------------
// WHICH ANIMALS BELONG TO WHICH SIDE.
//
// The two programs share ONE Animal table — that is deliberate, and it is what
// makes the nav toggle carry a bull across rather than dump the user on a list.
// But sharing the roster is not the same as sharing the LINEUP. The CDCB import
// creates an Animal row for every evaluated bull in America (~70,000 in the April
// 2026 round alone). Without a scope, every one of them lands in the Canadian
// lineup and every Canadian headline count, and a stud of a few hundred sires
// becomes a list of seventy thousand strangers.
//
// THE RULE
//
//   American side: the animal has a US evaluation. Nothing else qualifies —
//   a bull with no CDCB proof has no American number to show.
//
//   Canadian side: the animal has a Canadian evaluation, OR it has no American
//   one either. The second half is the important half and it is not symmetric on
//   purpose: an animal entered by hand and not yet proofed has no evaluation of
//   any kind, and it must NOT vanish from the Canadian lineup just because it is
//   waiting on its first round. Only animals that are American-and-only-American
//   are excluded.
//
// A bull with both proofs — which is most of the Blondin lineup — appears on BOTH
// sides. That is the whole point of the double card.
//
// Archived-ness is deliberately NOT folded in here. Callers already apply their
// own archived/proofStatus filters and combine them with these, and burying a
// second predicate inside this one would make those filters lie.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";

/**
 * Animals that belong in the CANADIAN lineup: proofed in Canada, or not yet
 * proofed anywhere. Excludes the CDCB import's American-only bulls.
 */
export const CA_ROSTER: Prisma.AnimalWhereInput = {
  OR: [
    { evaluations: { some: {} } },
    { usEvaluations: { none: {} } },
  ],
};

/** Animals that belong in the AMERICAN lineup: they have a CDCB evaluation. */
export const US_ROSTER: Prisma.AnimalWhereInput = {
  usEvaluations: { some: {} },
};

/** The scope for a system, for code that is generic over the two. */
export function rosterScope(system: "ca" | "us"): Prisma.AnimalWhereInput {
  return system === "us" ? US_ROSTER : CA_ROSTER;
}

/**
 * The same rule for a relation filter, e.g. counting evaluations whose animal is
 * on the Canadian side. Kept as a function so callers cannot accidentally share
 * and mutate one object literal.
 */
export function caRosterRelation(): Prisma.AnimalWhereInput {
  return { OR: [{ evaluations: { some: {} } }, { usEvaluations: { none: {} } }] };
}
