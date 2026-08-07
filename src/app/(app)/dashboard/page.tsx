import Link from "next/link";
import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { cached } from "@/lib/aggregate-cache";
import { CA_ROSTER } from "@/lib/roster-scope";
import { Card, Table, EmptyState } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { LineChart, type LineSeries } from "@/components/TrendCharts";

export const dynamic = "force-dynamic";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Traits that can be charted / ranked. Every one is backed by an
// (isPreferred, col) index, so the leaderboard query stays fast at ~100k rows.
const TRAITS = [
  { key: "lpi", col: "lpi", label: "LPI" },
  { key: "conf", col: "conf", label: "Conformation" },
  { key: "pro", col: "proDollar", label: "Pro$" },
  { key: "milk", col: "milk", label: "Milk" },
  { key: "fat", col: "fat", label: "Fat" },
  { key: "prot", col: "prot", label: "Protein" },
] as const;

const monthYear = (d: Date) => `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

export default async function DashboardPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const sp = searchParams;
  const chartTrait = TRAITS.find((t) => t.key === sp.ctrait) ?? TRAITS[0];
  const rankTrait = TRAITS.find((t) => t.key === sp.rank) ?? TRAITS[0];
  const cCol = chartTrait.col;
  const rCol = rankTrait.col;

  // ---------------------------------------------------------------------------
  // THE LOAD IS CACHED, and the reason is measured: this page took 7.2 s while
  // emitting only 84 KB, so essentially all of it was database time. Every figure
  // on it is a ROUND-LEVEL aggregate that changes only when an import runs, which
  // is exactly what src/lib/aggregate-cache.ts is for. No bull's own card reads
  // from it.
  //
  // The key carries the LEADERBOARD trait only. The chart trait does not belong
  // in it: `rounds` already returns an average for every chartable column, so
  // switching the chart re-reads the same cached rows. The leaderboard is a
  // different ten bulls per trait and genuinely needs its own entry.
  // ---------------------------------------------------------------------------
  const {
    totalAnimals, activeSires, avgLpiActive, totalEvals, maxDate, windowStart, breedRows, topBulls, rounds,
  } = await cached(`ca:dashboard:${rankTrait.key}`, () => loadDashboard(rCol));


  // Chart: one point per proof round in the window, y = the round's average of
  // the selected trait. Every round is plotted — official and interim alike, one
  // canonical (official-preferred) value per sire per round.
  const roundData = rounds.map((r) => {
    const avg = (r as unknown as Record<string, number | null>)[cCol];
    return { date: r.evaluationDate, y: avg != null ? Math.round(avg) : null, n: r.n, official: r.hasOfficial };
  });
  const series: LineSeries[] = [{
    label: `Average ${chartTrait.label}`,
    color: "#16a085",
    points: roundData.map((p) => ({
      x: `${MON[p.date.getUTCMonth()]} '${String(p.date.getUTCFullYear()).slice(2)}`,
      y: p.y,
      note: `${fmtNum(p.n)} sires · ${p.official ? "official" : "interim"}`,
    })),
  }];
  const hasChart = roundData.some((p) => p.y != null);
  const recentRounds = [...roundData].reverse().slice(0, 8);

  const topRows = topBulls.map((b, i) => ({
    rank: i + 1,
    id: b.animal.id,
    name: b.animal.primaryName,
    naab: b.animal.identifiers[0]?.idValue ?? null,
    val: (b as Record<string, unknown>)[rCol] as number | null,
    lpi: b.lpi,
    conf: b.conf,
  }));

  return (
    <div className="space-y-4">
      {/* breadcrumb + data window */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-semibold text-slate-700">Blondin Sires</span>
          <span className="mx-1.5 text-slate-300">·</span>
          <span className="font-semibold text-slate-900">Dashboard</span>
        </div>
        {maxDate && (
          <div className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-slate-400" aria-hidden="true">
              <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 3v3M16 3v3" />
            </svg>
            {monthYear(windowStart)} – {monthYear(maxDate)}
          </div>
        )}
      </div>

      {/* KPI icon tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <IconStat tone="teal" label="Total bulls" value={fmtNum(totalAnimals)}
          icon={<><path d="M3.5 5c2.2 0 3.9 1 4.9 2.8" /><path d="M20.5 5c-2.2 0-3.9 1-4.9 2.8" /><path d="M6.5 7.5h11V10a5.5 5.5 0 0 1-11 0z" /><path d="M9 13.7c0-1.4 1.3-2.3 3-2.3s3 .9 3 2.3-1.3 2.4-3 2.4-3-1-3-2.4z" /><path d="M11 13.8v.01" /><path d="M13 13.8v.01" /></>} />
        <IconStat tone="navy" label="Active sires" value={fmtNum(activeSires)}
          icon={<><path d="M3 12h4l2-5 4 10 2-5h6" /></>} />
        <IconStat tone="orange" label="Avg LPI (active)" value={avgLpiActive != null ? fmtNum(avgLpiActive) : "—"}
          icon={<><path d="M4 16l5-5 4 4 7-7" /><path d="M17 8h4v4" /></>} />
        <IconStat tone="red" label="Proof records" value={fmtNum(totalEvals)}
          icon={<><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5" /><path d="M3 16l9 5 9-5" /></>} />
      </div>

      {/* chart + breed breakdown */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={`Average ${chartTrait.label} · last 12 months`} actions={<TraitTabs active={chartTrait.key} param="ctrait" sp={sp} />}>
          {hasChart ? (
            <>
              <LineChart series={series} height={260} yLabel={chartTrait.label} />
              <p className="mt-2 text-[11px] text-slate-400">
                Each point is a proof round in the last 12 months — official and interim rounds alike. Hover a point for that round&apos;s average and sire count. Where a round shipped both, each sire is counted once on his official proof.
              </p>
            </>
          ) : (
            <EmptyState message="No proof rounds in the last 12 months to chart yet." />
          )}
        </Card>

        <Card title="Sires by breed">
          {breedRows.length === 0 ? (
            <EmptyState message="No animals yet." />
          ) : (
            <Table head={<><th className="th">Breed</th><th className="th text-right">Bulls</th><th className="th text-right">Avg LPI</th></>}>
              {breedRows.map((r) => (
                <tr key={r.name}>
                  <td className="td">{r.name}</td>
                  <td className="td text-right tabular-nums">{fmtNum(r.count)}</td>
                  <td className="td text-right tabular-nums">{r.avgLpi ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* top bulls (trait-rankable) + recent rounds */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Top 10 bulls" actions={<TraitTabs active={rankTrait.key} param="rank" sp={sp} />}>
          {topRows.length === 0 ? (
            <EmptyState message="No proofs imported yet." />
          ) : (
            <Table head={<>
              <th className="th w-8">#</th>
              <th className="th">Bull</th>
              <th className="th text-right">{rankTrait.label}</th>
              <th className="th text-right">LPI</th>
              <th className="th text-right">Conf</th>
            </>}>
              {topRows.map((r) => (
                <tr key={r.id}>
                  <td className="td text-slate-400">{r.rank}</td>
                  <td className="td">
                    <Link href={`/animals/${r.id}`} className="link font-medium">{r.name}</Link>
                    {r.naab && <div className="text-[11px] text-slate-400">{r.naab}</div>}
                  </td>
                  <td className="td text-right font-semibold tabular-nums text-brand-700">{r.val ?? "—"}</td>
                  <td className="td text-right tabular-nums text-slate-600">{r.lpi ?? "—"}</td>
                  <td className="td text-right tabular-nums text-slate-600">{r.conf ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Recent proof rounds">
          {recentRounds.length === 0 ? (
            <EmptyState message="No rounds in the window yet." />
          ) : (
            <Table head={<><th className="th">Round</th><th className="th text-right">Sires</th><th className="th text-right">Avg {chartTrait.label}</th></>}>
              {recentRounds.map((p) => (
                <tr key={p.date.toISOString()}>
                  <td className="td">
                    {MON[p.date.getUTCMonth()]} {p.date.getUTCFullYear()}
                    {p.official && <span className="ml-1.5 rounded bg-brand-100 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">official</span>}
                  </td>
                  <td className="td text-right tabular-nums">{fmtNum(p.n)}</td>
                  <td className="td text-right tabular-nums">{p.y ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Every query this page needs. Kept out of the component so the whole thing can
// sit behind one cache entry rather than eight.
//
// NOTE ON Promise.all HERE: it does NOT make these run in parallel. src/lib/db.ts
// pins connection_limit=1 on Vercel, so they queue and the page pays the SUM of
// their latencies either way. It is kept because it is the clearer shape, and
// because the fix that actually matters is not running them at all on the second
// view. What DID matter was the per-breed N+1 below.
// ---------------------------------------------------------------------------
async function loadDashboard(rCol: string) {
  // Phase 1 — headline counts, breeds, the latest round on file, and the
  // trait-ranked leaderboard.
  const [totalAnimals, activeSires, avgActiveAgg, totalEvals, maxAgg, breeds, byBreedCount, topBulls] = await Promise.all([
    // ...CANADIAN animals only. The CDCB import adds an Animal row per evaluated
    // American bull, and counting those here would report a lineup of seventy
    // thousand. The evaluation-based figures below are already Canada-only,
    // because they read GeneticEvaluation; these three count Animal directly.
    prisma.animal.count({ where: { archived: false, ...CA_ROSTER } }),
    prisma.animal.count({ where: { archived: false, proofStatus: "active", ...CA_ROSTER } }),
    prisma.geneticEvaluation.aggregate({ _avg: { lpi: true }, where: { isPreferred: true, animal: { archived: false, proofStatus: "active" } } }),
    prisma.geneticEvaluation.count(),
    prisma.geneticEvaluation.aggregate({ _max: { evaluationDate: true } }),
    prisma.breed.findMany(),
    prisma.animal.groupBy({ by: ["breedId"], where: { archived: false, ...CA_ROSTER }, _count: true }),
    prisma.geneticEvaluation.findMany({
      where: { isPreferred: true, animal: { archived: false }, [rCol]: { not: null } } as Prisma.GeneticEvaluationWhereInput,
      orderBy: { [rCol]: "desc" } as Prisma.GeneticEvaluationOrderByWithRelationInput,
      take: 10,
      select: {
        lpi: true, conf: true, proDollar: true, milk: true, fat: true, prot: true,
        animal: { select: { id: true, primaryName: true, identifiers: { where: { idType: "naab", active: true }, take: 1, select: { idValue: true } } } },
      },
    }),
  ]);

  const maxDate = maxAgg._max.evaluationDate;
  // The chart window: the same month a year before the most recent round on
  // file (so it always shows the last ~12 months of ACTUAL data).
  const windowStart = maxDate ? new Date(Date.UTC(maxDate.getUTCFullYear() - 1, maxDate.getUTCMonth(), 1)) : new Date(0);

  const topBreedIds = [...byBreedCount]
    .sort((a, b) => b._count - a._count)
    .slice(0, 6)
    .map((g) => g.breedId)
    .filter((id): id is string => !!id);

  // Phase 2 — per-round trait averages across the window, and per-breed avg LPI.
  // A month can now carry BOTH the official and the interim file for a bull, so
  // averaging the raw rows would count him twice and blend the two files. Collapse
  // to one canonical row per (bull, round) first — the official one where it
  // exists — so each sire counts once and the average reflects the settled proof.
  // `hasOfficial` marks a round that actually shipped an official file, which is
  // what the OFFICIAL badge should mean now that the field, not the month, decides.
  type RoundRow = {
    evaluationDate: Date; lpi: number | null; proDollar: number | null; conf: number | null;
    milk: number | null; fat: number | null; prot: number | null; n: number; hasOfficial: boolean;
  };
  const [rounds, breedAvgs] = await Promise.all([
    prisma.$queryRawUnsafe<RoundRow[]>(
      `WITH canon AS (
         SELECT DISTINCT ON (g."animalId", g."evaluationDate")
                g."evaluationDate", g."lpi", g."proDollar", g."conf", g."milk", g."fat", g."prot", g."runKind"
         FROM "GeneticEvaluation" g
         JOIN "Animal" a ON a."id" = g."animalId"
         WHERE g."evaluationDate" >= $1 AND a."archived" = false
         ORDER BY g."animalId", g."evaluationDate",
                  CASE g."runKind" WHEN 'official' THEN 0 WHEN 'interim' THEN 1 ELSE 2 END,
                  g."lpi" DESC NULLS LAST
       )
       SELECT "evaluationDate",
              AVG("lpi")::float AS "lpi", AVG("proDollar")::float AS "proDollar",
              AVG("conf")::float AS "conf", AVG("milk")::float AS "milk",
              AVG("fat")::float AS "fat", AVG("prot")::float AS "prot",
              COUNT(*)::int AS "n",
              bool_or("runKind" = 'official') AS "hasOfficial"
       FROM canon GROUP BY "evaluationDate" ORDER BY "evaluationDate" ASC`,
      windowStart,
    ),
    // THIS WAS AN N+1: one aggregate per breed, each joining GeneticEvaluation to
    // Animal across 63,052 rows, and on a pool pinned to ONE connection those six
    // queries ran strictly head to tail. It is one grouped query now.
    //
    // Raw SQL because the grouping column lives on the RELATION — Prisma's groupBy
    // can only group by fields of the model being grouped, and `breedId` is on
    // Animal, not on GeneticEvaluation.
    topBreedIds.length
      ? prisma.$queryRawUnsafe<{ breedId: string; avgLpi: number | null }[]>(
          `SELECT a."breedId" AS "breedId", AVG(g."lpi")::float AS "avgLpi"
             FROM "GeneticEvaluation" g
             JOIN "Animal" a ON a."id" = g."animalId"
            WHERE g."isPreferred" = true
              AND a."archived" = false
              AND a."breedId" = ANY($1::text[])
            GROUP BY a."breedId"`,
          topBreedIds,
        )
      : Promise.resolve([]),
  ]);

  const breedName = new Map(breeds.map((b) => [b.breedId, b.breedName]));
  const countById = new Map(byBreedCount.map((g) => [g.breedId, g._count]));
  const avgByBreed = new Map(breedAvgs.map((r) => [r.breedId, r.avgLpi]));
  const breedRows = topBreedIds.map((id) => {
    const avg = avgByBreed.get(id);
    return {
      name: breedName.get(id) ?? "Unknown",
      count: countById.get(id) ?? 0,
      avgLpi: avg != null ? Math.round(avg) : null,
    };
  });

  return {
    totalAnimals, activeSires, totalEvals, maxDate, windowStart, breedRows, topBulls, rounds,
    avgLpiActive: avgActiveAgg._avg.lpi != null ? Math.round(avgActiveAgg._avg.lpi) : null,
  };
}

// Haystack-style KPI tile: a coloured icon square beside a label and big value.
function IconStat({ tone, icon, label, value }: { tone: "teal" | "navy" | "orange" | "red"; icon: ReactNode; label: string; value: ReactNode }) {
  const tones = { teal: "bg-brand-600", navy: "bg-navy-500", orange: "bg-accent-500", red: "bg-red-500" };
  return (
    <div className="card flex items-center gap-4 p-4">
      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white ${tones[tone]}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">{icon}</svg>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-2xl font-bold text-slate-900">{value}</div>
      </div>
    </div>
  );
}

// Trait selector shown in a card header. prefetch={false} is essential: each
// destination is force-dynamic, so a prefetch would fire a full DB render — with
// two of these (chart + leaderboard) that is a dozen links racing on hover.
function TraitTabs({ active, param, sp }: { active: string; param: "ctrait" | "rank"; sp: Record<string, string | undefined> }) {
  const href = (key: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== param) p.set(k, v);
    p.set(param, key);
    return `/dashboard?${p.toString()}`;
  };
  return (
    <div className="flex flex-wrap gap-1">
      {TRAITS.map((t) => (
        <Link
          key={t.key}
          href={href(t.key)}
          prefetch={false}
          scroll={false}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${active === t.key ? "bg-brand-600 text-white" : "border border-slate-200 text-slate-500 hover:bg-slate-50"}`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
