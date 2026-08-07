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
//   Canadian side: the animal has a Canadian evaluation, OR the CDCB import never
//   touched it — "the animals that were in the database before the American
//   addition", in the owner's words.
//
// WHY THE TEST IS THE IDENTIFIER AND NOT "HAS NO US EVALUATION". That was the
// first attempt and it was wrong by 18,500 rows. The importer writes an Animal
// for every id17 it meets, INCLUDING the sires and dams named in CDCB pedigrees,
// and those referenced ancestors never get a UsEvaluation of their own — so
// "no American evaluation" waved every one of them onto the Canadian side. What
// every CDCB-touched animal does carry is an AnimalIdentifier of type
// `cdcb_id17` (persist.ts writes it whether the animal was created or matched),
// and that is the durable mark of American provenance.
//
// The Canadian-evaluation clause has to come first, because a dual-registered
// bull is MATCHED to an existing Canadian animal and therefore also carries the
// cdcb_id17 identifier. His Lactanet proof is what keeps him Canadian.
//
// An animal entered by hand and never proofed has no identifier of that type
// either, so it stays Canadian and does not vanish while awaiting a first round.
//
// A bull with both proofs — which is most of the Blondin lineup — appears on BOTH
// sides. That is the whole point of the double card.
//
// Archived-ness is deliberately NOT folded in here. Callers already apply their
// own archived/proofStatus filters and combine them with these, and burying a
// second predicate inside this one would make those filters lie.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { CDCB_ID_TYPE } from "./us-cdcb/persist";

/**
 * Animals that belong in the CANADIAN lineup: proofed in Canada, or not yet
 * proofed anywhere. Excludes the CDCB import's American-only bulls.
 */
export const CA_ROSTER: Prisma.AnimalWhereInput = {
  OR: [
    { evaluations: { some: {} } },
    { identifiers: { none: { idType: CDCB_ID_TYPE } } },
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
  return { OR: [{ evaluations: { some: {} } }, { identifiers: { none: { idType: CDCB_ID_TYPE } } }] };
}
