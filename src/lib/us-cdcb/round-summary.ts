// ---------------------------------------------------------------------------
// "What changed this round" — the American digest, as one report object.
//
// The query used to live inside the page. It moved here the moment the report
// gained exports, for the reason report-html.ts states about the Canadian side:
// the page, the workbook and the emailable HTML must be the SAME report. If each
// built its own the three would agree today and disagree after the first edit,
// and a customer would be holding an attachment that contradicts the screen.
//
// So this module owns every number and every ordering decision. The page and the
// exports only choose how many rows to show — and each says how many it showed.
//
// Reads UsEvaluation only, never GeneticEvaluation. A Lactanet EBV in kilograms
// landing in a column headed GTPI would be the worst bug this product could ship.
//
// Three things make this NOT a translation of the Canadian round digest:
//
//   * ONLY OFFICIAL ROUNDS COUNT. CDCB ships one file per triannual round, and
//     the monthly/weekly adds are provisional values for animals that had none
//     before. Comparing a bull's provisional February figure to his official
//     April one measures the publication, not the bull.
//   * GRADUATING BULLS GET THEIR OWN LIST. A bull moving from a genomic
//     evaluation to a daughter-proven one moves roughly six times a normal round.
//     That is the most informative signal on this side and also the most
//     expected; mixing it into "moved unusually" would bury the genuinely
//     surprising bulls under a list of bulls doing exactly what a first crop of
//     daughters does.
//   * GTPI IS OURS, NOT CDCB'S. Every figure below is computed (see
//     index-registry.ts) and only for Holstein, so this digest is a Holstein
//     digest whatever else the round contains.
// ---------------------------------------------------------------------------

import { prisma } from "../db";
import { isMissingUsTables, usRoundLabel } from "./proof-change";

/**
 * One SD flags about a third of a normal distribution. That is a usable
 * sensitivity on the Canadian lineup of a few hundred NAAB bulls; on a full CDCB
 * round — tens of thousands of animals — it would produce a "notable movers"
 * list nobody could read. 1.5 keeps the section to the genuinely unusual.
 */
export const SD_MULT = 1.5;

/** Rows the SCREEN shows in the gainers / drops cards. The exports show more. */
export const TOP_MOVER_LIMIT = 10;
/** Rows the SCREEN shows in the notable-movers and graduates lists. */
export const LIST_LIMIT = 25;

/** At least this many ordinary bulls before a spread means anything. */
const MIN_COHORT = 3;

export interface Mover {
  usAnimalId: string;
  name: string;
  naabCode: string | null;
  evalBreed: string | null;
  previous: number;
  latest: number;
  delta: number;
  graduating: boolean;
  /** SDs from how the round's own cohort moved. null when the cohort can't support one. */
  z: number | null;
}

export interface UsRoundSummary {
  /** True when the US tables have not been created yet (importer not run). */
  missingTables: boolean;

  latestRound: string | null;
  previousRound: string | null;
  latestLabel: string;
  previousLabel: string;

  /** Bulls carrying a calculated GTPI in the latest round, comparable or not. */
  updated: number;
  /** Non-graduating bulls with a GTPI in both rounds — the statistical cohort. */
  ordinary: Mover[];
  /** First daughter proof this round, sorted by new GTPI, highest first. */
  graduates: Mover[];

  /** Mean and SD of the ORDINARY bulls' GTPI movement. Graduates are excluded. */
  mean: number;
  sd: number;
  sdMult: number;

  /** Mean move, rounded — null when nothing was comparable. */
  avg: number | null;
  up: number;
  down: number;

  /** Ordinary bulls past the bar, biggest |z| first. */
  flagged: Mover[];
  /** Ordinary bulls that gained, biggest gain first. */
  gainers: Mover[];
  /** Ordinary bulls that lost, biggest loss first. */
  drops: Mover[];
}

function empty(latestRound: string | null, previousRound: string | null, missingTables = false): UsRoundSummary {
  return {
    missingTables,
    latestRound,
    previousRound,
    latestLabel: latestRound ? usRoundLabel(latestRound) : "—",
    previousLabel: previousRound ? usRoundLabel(previousRound) : "—",
    updated: 0,
    ordinary: [],
    graduates: [],
    mean: 0,
    sd: 0,
    sdMult: SD_MULT,
    avg: null,
    up: 0,
    down: 0,
    flagged: [],
    gainers: [],
    drops: [],
  };
}

/**
 * Load the newest official round, the official round before it, and every bull
 * that carries a calculated GTPI in both.
 *
 * The previous side is the previous ROUND, not each bull's own previous
 * evaluation. On this side that is the same thing in practice: `all_evaluated`
 * republishes the whole reference population every round, and a bull graduating
 * out of `young_pub` was published in the same previous round by the other
 * family. Pinning it to one round also keeps this to two indexed reads instead
 * of walking every bull's history.
 *
 * The US tables are created by `prisma db push`. Until that has run, this returns
 * `missingTables` rather than throwing — that is a setup state, not a fault, and
 * every American page and export has to survive it.
 */
export async function getUsRoundSummary(): Promise<UsRoundSummary> {
  // Caught rather than annotated: Prisma infers groupBy's row shape from the
  // argument, and giving the result an explicit type breaks that inference.
  const rounds = await prisma.usEvaluation
    .groupBy({
      by: ["roundCode"],
      where: { runKind: "official", approvalStatus: "approved", roundCode: { not: null } },
      orderBy: { roundCode: "desc" },
      take: 2,
    })
    .catch((e: unknown) => {
      if (isMissingUsTables(e)) return null;
      throw e;
    });
  if (rounds === null) return empty(null, null, true);

  // roundCode is YYMM, so a lexical sort is a chronological one.
  const latestRound = rounds[0]?.roundCode ?? null;
  const previousRound = rounds[1]?.roundCode ?? null;
  // Two official rounds are the minimum: one round on its own has nothing to
  // have changed FROM, and a provisional add is not a substitute for one.
  if (!latestRound || !previousRound) return empty(latestRound, previousRound);

  const [latestRows, previousRows] = await Promise.all([
    prisma.usEvaluation.findMany({
      where: { roundCode: latestRound, runKind: "official", approvalStatus: "approved", tpi: { not: null } },
      // A bull can appear in both triannual families for one round with identical
      // values; ordering by family makes the de-duplication below deterministic
      // and prefers the daughter-proven publication.
      orderBy: { sourceFamily: "asc" },
      select: {
        usAnimalId: true, tpi: true, isGraduation: true, naabCode: true, evalBreed: true,
        usAnimal: { select: { name: true } }, id17: true,
      },
    }),
    prisma.usEvaluation.findMany({
      where: { roundCode: previousRound, runKind: "official", approvalStatus: "approved", tpi: { not: null } },
      orderBy: { sourceFamily: "asc" },
      select: { usAnimalId: true, tpi: true },
    }),
  ]);

  const previousTpi = new Map<string, number>();
  for (const r of previousRows) if (r.tpi != null && !previousTpi.has(r.usAnimalId)) previousTpi.set(r.usAnimalId, r.tpi);

  const seen = new Set<string>();
  const movers: Mover[] = [];
  let updated = 0;
  for (const r of latestRows) {
    if (seen.has(r.usAnimalId)) continue;
    seen.add(r.usAnimalId);
    updated++;
    const previous = previousTpi.get(r.usAnimalId);
    if (previous == null || r.tpi == null) continue;
    movers.push({
      usAnimalId: r.usAnimalId,
      name: r.usAnimal.name ?? r.id17,
      naabCode: r.naabCode,
      evalBreed: r.evalBreed,
      previous,
      latest: r.tpi,
      delta: r.tpi - previous,
      graduating: r.isGraduation,
      z: null,
    });
  }

  const graduates = movers.filter((m) => m.graduating);
  const ordinary = movers.filter((m) => !m.graduating);

  // The cohort is the ordinary movers alone. Graduates would inflate the SD by
  // several times and hide the bulls that actually moved unexpectedly.
  const n = ordinary.length;
  const mean = n ? ordinary.reduce((s, m) => s + m.delta, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(ordinary.reduce((s, m) => s + (m.delta - mean) ** 2, 0) / n) : 0;
  if (n >= MIN_COHORT && sd > 0) for (const m of ordinary) m.z = (m.delta - mean) / sd;

  // Every ordering the report offers is decided once, here, so the page and the
  // exports show the same bulls in the same order and differ only in how far
  // down the list they go.
  const flagged = ordinary
    .filter((m) => m.z != null && Math.abs(m.z) >= SD_MULT - 1e-9)
    .sort((a, b) => Math.abs(b.z as number) - Math.abs(a.z as number));

  return {
    missingTables: false,
    latestRound,
    previousRound,
    latestLabel: usRoundLabel(latestRound),
    previousLabel: usRoundLabel(previousRound),
    updated,
    ordinary,
    graduates: [...graduates].sort((a, b) => b.latest - a.latest),
    mean,
    sd,
    sdMult: SD_MULT,
    avg: n ? Math.round(mean) : null,
    up: ordinary.filter((m) => m.delta > 0).length,
    down: ordinary.filter((m) => m.delta < 0).length,
    flagged,
    gainers: ordinary.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta),
    drops: ordinary.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta),
  };
}

/** Is this bull past the bar? One place, so the badge and the exports agree. */
export function isUnusualMover(m: Mover): boolean {
  return m.z != null && Math.abs(m.z) >= SD_MULT - 1e-9;
}
