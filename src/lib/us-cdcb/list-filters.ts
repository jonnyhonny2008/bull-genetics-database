// ---------------------------------------------------------------------------
// Filters for the American lineup list.
//
// The Canadian list gets its four sire roles from Animal.sireType / proofStatus,
// which prisma/classify-sires.ts materialises from the Lactanet proof-activity
// codes. None of that exists on this side, and the American answer is not the
// same shape either:
//
//   * PROVEN vs GENOMIC is UsEvaluation.isPtaMilk, and that flag describes the
//     PRODUCTION trait group, not the bull. A sire can be daughter-proven for
//     yield and still parent-average for calving, so the labels say which group
//     they are talking about rather than implying a whole-animal status.
//   * ACTIVE is CDCB's AI-status file (UsAiStatus), NOT the presence of a NAAB
//     code — plenty of evaluated bulls carry a code and are not being marketed.
//     That file is published PER ROUND, so the filter is scoped to the most
//     recent status round on file. "Has ever carried code A" would keep counting
//     a bull years after he was withdrawn.
//
// Everything here reads UsEvaluation / UsAiStatus only. A Canadian EBV in
// kilograms must never reach a page that labels its columns in pounds.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/** Where a role comes from: the evaluation basis, or CDCB's AI-status file. */
export type UsRoleKind = "basis" | "status";

export interface UsListRole {
  code: string;
  label: string;
  hint: string;
  kind: UsRoleKind;
}

/**
 * The role pills above the American lineup, in display order.
 *
 * The two basis roles always apply. The three status roles only mean anything
 * once an AI-status file has been imported, so the list page drops them when no
 * status round is on file rather than showing three pills that all read zero.
 */
export const US_LIST_ROLES: UsListRole[] = [
  {
    code: "proven",
    label: "Daughter-proven",
    hint: "CDCB reports this bull's PRODUCTION traits from daughter records (IS_PTA_MILK). His calving traits may still be parent-average.",
    kind: "basis",
  },
  {
    code: "genomic",
    label: "Parent-average",
    hint: "CDCB reports this bull's PRODUCTION traits from genomics and parent average, not daughters.",
    kind: "basis",
  },
  {
    code: "active",
    label: "Active AI",
    hint: "Code A in CDCB's AI-status file for the latest status round — the bull is in active AI service. Carrying a NAAB code is not the same thing.",
    kind: "status",
  },
  {
    code: "marketed",
    label: "Marketed young",
    hint: "Code G — a genomic young bull being marketed, with no daughter proof yet.",
    kind: "status",
  },
  {
    code: "foreign",
    label: "Foreign",
    hint: "Code F — evaluated by CDCB but marketed outside the United States.",
    kind: "status",
  },
];

/** Role code -> the single letter CDCB writes in the AI-status file. */
const STATUS_CODE: Record<string, string> = { active: "A", marketed: "G", foreign: "F" };

/**
 * The where-clause for one role pill, or null when the role is unrecognised or
 * cannot be answered (a status role with no AI-status file imported).
 */
export function usRoleWhere(role: string | undefined, statusRound: string | null): Prisma.UsEvaluationWhereInput | null {
  switch (role) {
    case "proven":
      return { isPtaMilk: true };
    case "genomic":
      return { isPtaMilk: false };
    case "active":
    case "marketed":
    case "foreign":
      // Resolved by the caller via usRoleWhereAsync — the status table joins on
      // id17, not through the Canadian Animal row (see the note there).
      return null;
    default:
      return null;
  }
}

/**
 * Free-text search over the things a user actually types: the bull's name, his
 * NAAB stud code, or his CDCB 17-character id. The id is stored upper-cased and
 * the NAAB code is not, so both are matched case-insensitively.
 */
export function usSearchWhere(q: string): Prisma.UsEvaluationWhereInput | null {
  const term = q.trim();
  if (!term) return null;
  return {
    OR: [
      { naabCode: { contains: term, mode: "insensitive" } },
      { id17: { contains: term, mode: "insensitive" } },
      { animal: { is: { primaryName: { contains: term, mode: "insensitive" } } } },
      { animal: { is: { shortName: { contains: term, mode: "insensitive" } } } },
    ],
  };
}

/** Restrict to the rows the signed-in user has favourited. */
export function usFavouriteWhere(userId: string): Prisma.UsEvaluationWhereInput {
  // Watchlist is keyed (userId, animalId) — it is ANIMAL-level, so a bull starred
  // on the Canadian side is already starred here. Nothing US-specific is stored.
  return { animal: { is: { watchers: { some: { userId } } } } };
}

/** The most recent round CDCB has published an AI-status file for, if any. */
export async function usLatestStatusRound(): Promise<string | null> {
  const row = await prisma.usAiStatus.findFirst({ orderBy: { roundCode: "desc" }, select: { roundCode: true } });
  return row?.roundCode ?? null;
}

/**
 * How many bulls match each role, given every other filter the user has applied.
 *
 * Two groupBy calls rather than five counts — the connection pool is the scarce
 * resource here, not the query (see the note in src/lib/db.ts). The status counts
 * are joined through the animal back into the lineup because roughly 5% of the
 * status file matches no animal we hold; counting the file directly would
 * describe CDCB's population rather than this stud's.
 */
export async function usRoleCounts(
  base: Prisma.UsEvaluationWhereInput,
  statusRound: string | null,
): Promise<Record<string, number>> {
  const [basis, status] = await Promise.all([
    prisma.usEvaluation.groupBy({ by: ["isPtaMilk"], where: base, _count: { _all: true } }),
    // Counted through id17 for the same reason usAiStatusIds exists: the Animal
    // relation is null for almost every American bull, so the old groupBy through
    // it returned zero for every pill.
    statusRound
      ? (async () => {
          const rows = await prisma.usAiStatus.findMany({
            where: { roundCode: statusRound },
            select: { id17: true, code: true },
          });
          const byCode = new Map<string, string[]>();
          for (const r of rows) {
            const a = byCode.get(r.code) ?? [];
            a.push(r.id17);
            byCode.set(r.code, a);
          }
          const out: { code: string; n: number }[] = [];
          for (const [code, ids] of byCode) {
            out.push({ code, n: await prisma.usEvaluation.count({ where: { ...base, id17: { in: ids } } }) });
          }
          return out;
        })()
      : Promise.resolve([] as { code: string; n: number }[]),
  ]);
  const nBasis = (v: boolean) => basis.find((b) => b.isPtaMilk === v)?._count._all ?? 0;
  const nStatus = (c: string) => status.find((s) => s.code === c)?.n ?? 0;
  return {
    proven: nBasis(true),
    genomic: nBasis(false),
    active: nStatus("A"),
    marketed: nStatus("G"),
    foreign: nStatus("F"),
  };
}


/**
 * The AI-status role filters, which cannot be expressed as a plain where-clause.
 *
 * UsAiStatus is joined on id17 rather than through Animal, DELIBERATELY: it has no
 * foreign key to UsAnimal because ~5% of its rows name a bull no evaluation
 * mentions, and a key would reject those. It used to go through
 * `animal: { is: { usAiStatus: ... } }`, which quietly returned nothing once the
 * rosters were split — an American bull has no Animal row unless he is also
 * registered in Canada, so 99.8% of the lineup fell out and every status pill
 * read zero while looking perfectly healthy.
 *
 * The id17 set for one code is at most a few thousand, so an IN list is the right
 * shape here and stays one extra query.
 */
export async function usAiStatusIds(role: string, statusRound: string | null): Promise<string[] | null> {
  const code = STATUS_CODE[role];
  if (!code || !statusRound) return null;
  const rows = await prisma.usAiStatus.findMany({
    where: { roundCode: statusRound, code },
    select: { id17: true },
  });
  return rows.map((r) => r.id17);
}
