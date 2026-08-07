// ---------------------------------------------------------------------------
// WHICH ANIMALS BELONG TO WHICH SIDE — and why this file is nearly empty now.
//
// The two programs used to share the Animal table, and a predicate here decided
// who appeared where. That approach failed twice, measurably:
//
//   * `usEvaluations: { none: {} }`      leaked 18,500 rows
//   * a `cdcb_id17` identifier test      leaked 20,000 rows
//
// The reason was never that the two populations look alike. It was that the CDCB
// importer wrote into the shared table in two passes — create the animals, then
// mark them — so every row created before an interruption was, briefly and then
// permanently, indistinguishable from a Canadian animal. A predicate cannot close
// a window like that; it can only describe rows after they exist.
//
// So the tables are split. UsAnimal holds the American roster (see the model
// comment in schema.prisma), Animal holds the Canadian one, and the question this
// file used to answer no longer arises: an animal is Canadian because it is IN the
// Canadian table. The scopes below are kept as named constants rather than deleted
// so call sites stay explicit about which roster they mean, and so there is one
// obvious place to look when someone asks how the two sides are kept apart.
//
// A bull registered in both countries has a row in BOTH tables, joined by
// UsAnimal.animalId. That is what the double card and the nav toggle run on.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";

/**
 * The Canadian lineup: every animal in the Animal table.
 *
 * EMPTY ON PURPOSE. It is not an oversight and it should not be "filled in" — the
 * Animal table is Canadian by construction now that the CDCB importer writes to
 * UsAnimal. Callers spread this into their own `where`, so the constant exists to
 * make that intent readable and to give the rule one home if it ever needs one
 * again. Adding a condition here silently narrows every Canadian list on the site.
 */
export const CA_ROSTER: Prisma.AnimalWhereInput = {};

/**
 * The American lineup, expressed against the AMERICAN table. Use with
 * prisma.usAnimal, not prisma.animal.
 *
 * Archived is excluded here rather than left to callers because, unlike the
 * Canadian side, nothing else on the US path filters it.
 */
export const US_ROSTER: Prisma.UsAnimalWhereInput = { archived: false };

/** The Canadian animals that ALSO have an American evaluation — the double cards. */
export const DUAL_REGISTERED: Prisma.AnimalWhereInput = { usAnimals: { some: {} } };
