import "server-only";
import { prisma } from "./db";

// ---------------------------------------------------------------------------
// Source priority resolution
//
// Preferred record = the APPROVED record whose source has the best (lowest)
// priority rank for the relevant data domain. Ties broken by most recent date.
// Rank comes from SourcePriorityRule; sources with no rule fall back to
// Source.defaultPriorityRank. Records with no source rank last.
// ---------------------------------------------------------------------------

export interface RankInfo {
  rank: number;
  sourceName: string;
  ruleMatched: boolean;
}

// Build a lookup of sourceId -> best applicable rank for a data domain.
export async function loadRankMap(
  dataDomain: string,
  breedId?: string | null,
): Promise<Map<string, RankInfo>> {
  const [rules, sources] = await Promise.all([
    prisma.sourcePriorityRule.findMany({
      where: { dataDomain, active: true },
      include: { source: true },
    }),
    prisma.source.findMany(),
  ]);

  const map = new Map<string, RankInfo>();

  // Seed with each source's default rank.
  for (const s of sources) {
    map.set(s.sourceId, {
      rank: s.defaultPriorityRank ?? 999,
      sourceName: s.sourceName,
      ruleMatched: false,
    });
  }

  // Apply explicit rules (prefer breed-specific over general, and best rank).
  for (const r of rules) {
    // A rule applies if it has no breed filter, or matches this animal's breed.
    if (r.breedId && breedId && r.breedId !== breedId) continue;
    const existing = map.get(r.sourceId);
    const better = !existing || !existing.ruleMatched || r.priorityRank < existing.rank;
    if (better) {
      map.set(r.sourceId, {
        rank: r.priorityRank,
        sourceName: r.source.sourceName,
        ruleMatched: true,
      });
    }
  }

  return map;
}

export interface PreferredPick<T> {
  chosen: T | null;
  reason: string;
}

// Given candidate records, choose the preferred one and explain why.
export function pickPreferred<T>(
  items: T[],
  opts: {
    getSourceId: (t: T) => string | null | undefined;
    getDate: (t: T) => Date | null | undefined;
    getApproval: (t: T) => string;
    rankMap: Map<string, RankInfo>;
    domainLabel: string;
    /**
     * Final tiebreak when source rank AND date are equal; lower wins.
     *
     * Genetic evaluations need this because Lactanet's official and interim
     * files for a round share an evaluationDate and a source, so the two are
     * indistinguishable to the sort above and the winner came down to whatever
     * order the database happened to return. Deliberately applied AFTER date,
     * not before: a newer interim round still supersedes an older official one,
     * which is how the reports have always read. It only decides same-day ties,
     * where official must win.
     */
    getTieBreak?: (t: T) => number;
  },
): PreferredPick<T> {
  const approved = items.filter((i) => opts.getApproval(i) === "approved");
  if (approved.length === 0) return { chosen: null, reason: "No approved records" };

  const scored = approved.map((item) => {
    const sid = opts.getSourceId(item);
    const info = sid ? opts.rankMap.get(sid) : undefined;
    return {
      item,
      rank: info?.rank ?? 999,
      sourceName: info?.sourceName ?? "Unknown source",
      date: opts.getDate(item)?.getTime() ?? 0,
      tie: opts.getTieBreak?.(item) ?? 0,
    };
  });

  scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.date !== a.date ? b.date - a.date : a.tie - b.tie));
  const winner = scored[0];

  const dateStr = winner.date ? new Date(winner.date).toISOString().slice(0, 10) : "n/a";
  const reason =
    `Highest-priority source for ${opts.domainLabel}: ${winner.sourceName} ` +
    `(priority ${winner.rank})${scored.length > 1 ? `, chosen over ${scored.length - 1} lower-priority record(s)` : ""}. ` +
    `Record date ${dateStr}.`;

  return { chosen: winner.item, reason };
}

// ---------------------------------------------------------------------------
// Persist isPreferred flags for one animal across all three domains.
// Called after any proof / milk / classification write or review approval.
// ---------------------------------------------------------------------------

export async function recomputePreferredForAnimal(animalId: string): Promise<void> {
  const animal = await prisma.animal.findUnique({ where: { id: animalId } });
  const breedId = animal?.breedId ?? null;

  // --- Genetic evaluations ---
  {
    const rankMap = await loadRankMap("genetic_evaluation", breedId);
    const evals = await prisma.geneticEvaluation.findMany({ where: { animalId } });
    const { chosen } = pickPreferred(evals, {
      getSourceId: (e) => e.sourceId,
      getDate: (e) => e.evaluationDate,
      getApproval: (e) => e.approvalStatus,
      // Same-day tie: the official round outranks the interim one. Matches the
      // window function in prisma/import-cdn.ts, so a bulk import and a single
      // web import can never disagree about which row is preferred.
      getTieBreak: (e) => (e.runKind === "official" ? 0 : e.runKind === "interim" ? 1 : 2),
      rankMap,
      domainLabel: "genetic evaluations",
    });
    await Promise.all(
      evals.map((e) =>
        prisma.geneticEvaluation.update({
          where: { evaluationId: e.evaluationId },
          data: { isPreferred: chosen?.evaluationId === e.evaluationId },
        }),
      ),
    );
  }

  // --- Milk records --- (preferred per lactation number)
  {
    const rankMap = await loadRankMap("milk_record", breedId);
    const milk = await prisma.milkRecord.findMany({ where: { animalId } });
    const byLactation = new Map<string, typeof milk>();
    for (const m of milk) {
      const key = String(m.lactationNumber ?? "na");
      const arr = byLactation.get(key) ?? [];
      arr.push(m);
      byLactation.set(key, arr);
    }
    const preferredIds = new Set<string>();
    for (const arr of byLactation.values()) {
      const { chosen } = pickPreferred(arr, {
        getSourceId: (m) => m.sourceId,
        getDate: (m) => m.recordDate,
        getApproval: (m) => m.approvalStatus,
        rankMap,
        domainLabel: "milk records",
      });
      if (chosen) preferredIds.add(chosen.milkRecordId);
    }
    await Promise.all(
      milk.map((m) =>
        prisma.milkRecord.update({
          where: { milkRecordId: m.milkRecordId },
          data: { isPreferred: preferredIds.has(m.milkRecordId) },
        }),
      ),
    );
  }

  // --- Classification --- (preferred = latest approved from best source)
  {
    const rankMap = await loadRankMap("classification", breedId);
    const cls = await prisma.classificationRecord.findMany({ where: { animalId } });
    const { chosen } = pickPreferred(cls, {
      getSourceId: (c) => c.sourceId,
      getDate: (c) => c.classificationDate,
      getApproval: (c) => c.approvalStatus,
      rankMap,
      domainLabel: "classification",
    });
    await Promise.all(
      cls.map((c) =>
        prisma.classificationRecord.update({
          where: { classificationId: c.classificationId },
          data: { isPreferred: chosen?.classificationId === c.classificationId },
        }),
      ),
    );
  }
}
