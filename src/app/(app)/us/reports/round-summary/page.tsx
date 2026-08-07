import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, StatCard, EmptyState, Badge, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { cdcbRoundLabel } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// "What changed this round" — the American digest, read from UsEvaluation only.
// Never GeneticEvaluation: a Lactanet EBV in kg landing in a column headed GTPI
// would be the worst bug this product could ship.
//
// Three things make this NOT a translation of the Canadian page:
//
//   * ONLY OFFICIAL ROUNDS COUNT. CDCB ships one file per triannual round, and
//     the monthly/weekly adds are provisional values for animals that had none
//     before. Comparing a bull's provisional February figure to its official
//     April one measures the publication, not the bull, so those rows are
//     excluded from both sides of every comparison here.
//   * GRADUATING BULLS GET THEIR OWN SECTION. A bull moving from a genomic
//     evaluation to a daughter-proven one moves roughly six times a normal
//     round. That is the most informative signal on this side, but it is also
//     entirely expected — mixing it into "moved unusually" would bury the
//     genuinely surprising bulls under a list of bulls doing exactly what a
//     first crop of daughters does.
//   * GTPI IS OURS, NOT CDCB'S. Every figure below is computed (see
//     index-registry.ts) and is only computed for Holstein, so this digest is a
//     Holstein digest whatever else the round contains.
// ---------------------------------------------------------------------------

// One SD flags about a third of a normal distribution. That is a usable
// sensitivity on the Canadian lineup of a few hundred NAAB bulls; on a full CDCB
// round — tens of thousands of animals — it would produce a "notable movers"
// list nobody could read. 1.5 keeps the section to the genuinely unusual.
const SD_MULT = 1.5;

const signed = (n: number | null | undefined) =>
  n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(Math.round(n)))}`;

/** Human label for a triannual round code (YYMM), via the shared formatter. */
const labelRound = (roundCode: string) =>
  cdcbRoundLabel({
    family: "all_evaluated",
    kind: "official",
    breed: null,
    roundCode,
    periodKey: `R${roundCode}`,
    date: roundCode,
  }) ?? roundCode;

interface Mover {
  animalId: string;
  name: string;
  naabCode: string | null;
  evalBreed: string | null;
  previous: number;
  latest: number;
  delta: number;
  graduating: boolean;
  z: number | null;
}

export default async function UsRoundSummaryPage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  let data: Awaited<ReturnType<typeof loadDigest>> | null = null;
  let missingTables = false;
  try {
    data = await loadDigest();
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, say so
    // plainly rather than rendering a 500 — this is a setup state, not a fault.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) {
      missingTables = true;
    } else throw e;
  }

  if (missingTables) {
    return (
      <div>
        <PageHeader title="What changed this round" subtitle="CDCB evaluations" />
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run db:push:prod</pre>
          <p className="mt-3 text-sm text-slate-600">Then import at least two CDCB rounds:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      </div>
    );
  }

  // Two official rounds are the minimum: one round on its own has nothing to
  // have changed FROM, and a provisional add is not a substitute for one.
  if (!data || !data.latestRound || !data.previousRound) {
    return (
      <div>
        <PageHeader
          title="What changed this round"
          subtitle={
            data?.latestRound
              ? `${labelRound(data.latestRound)} is the only official round on file.`
              : "CDCB evaluations — April / August / December"
          }
        />
        <EmptyState message="No round-over-round movement to summarise yet — two official CDCB rounds are needed. Monthly and weekly adds are provisional and are never compared as rounds." />
      </div>
    );
  }

  const { latestRound, previousRound, updated, ordinary, graduates, mean, sd } = data;
  const deltas = ordinary.map((m) => m.delta);
  const avg = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  const up = deltas.filter((d) => d > 0).length;
  const down = deltas.filter((d) => d < 0).length;

  const flagged = ordinary.filter((m) => m.z != null && Math.abs(m.z) >= SD_MULT - 1e-9);
  const gainers = [...ordinary].sort((a, b) => b.delta - a.delta).slice(0, 10).filter((m) => m.delta > 0);
  const drops = [...ordinary].sort((a, b) => a.delta - b.delta).slice(0, 10).filter((m) => m.delta < 0);
  const topGraduates = [...graduates].sort((a, b) => b.latest - a.latest).slice(0, 25);

  const MoverTable = ({ list, showFlag = true }: { list: Mover[]; showFlag?: boolean }) => (
    <Table
      head={
        <>
          <th className="th">Bull</th>
          <th className="th text-right">Previous</th>
          <th className="th text-right">Latest</th>
          <th className="th text-right">GTPI Δ</th>
        </>
      }
    >
      {list.map((m) => (
        <tr key={m.animalId} className="hover:bg-slate-50">
          <td className="td">
            <Link href={`/us/animals/${m.animalId}`} className="link font-medium">{m.name}</Link>
            {m.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {m.naabCode}</span>}
            {showFlag && m.z != null && Math.abs(m.z) >= SD_MULT - 1e-9 && (
              <span className="ml-2 align-middle"><Badge tone="amber">moved ≥{SD_MULT} SD</Badge></span>
            )}
          </td>
          <td className="td text-right tabular-nums text-slate-500">{fmtNum(m.previous)}</td>
          <td className="td text-right tabular-nums text-slate-700">{fmtNum(m.latest)}</td>
          <td className={`td text-right font-semibold tabular-nums ${m.delta > 0 ? "text-emerald-700" : m.delta < 0 ? "text-red-600" : "text-slate-500"}`}>
            {signed(m.delta)}
          </td>
        </tr>
      ))}
    </Table>
  );

  return (
    <div>
      <PageHeader
        title="What changed this round"
        subtitle={
          <span>
            {labelRound(latestRound)} <Badge tone="blue">Official</Badge> — each bull&rsquo;s{" "}
            <strong>calculated</strong> GTPI against its {labelRound(previousRound)} figure.
          </span>
        }
      />

      {ordinary.length === 0 && graduates.length === 0 ? (
        <EmptyState message="No bull carries a calculated GTPI in both rounds, so there is no movement to report. GTPI is computed for Holstein only." />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Bulls updated" value={fmtNum(updated)} hint={`GTPI in ${labelRound(latestRound)}`} />
            <StatCard
              label="Avg GTPI move"
              value={signed(avg)}
              tone={avg != null && avg >= 0 ? "good" : "warn"}
              hint="excludes graduating bulls"
            />
            <StatCard label="Up / Down" value={`${fmtNum(up)} / ${fmtNum(down)}`} hint="GTPI gained vs lost" />
            <StatCard
              label="Moved unusually"
              value={fmtNum(flagged.length)}
              tone={flagged.length ? "accent" : "default"}
              hint={`≥${SD_MULT} SD from the round's mean move`}
            />
            <StatCard
              label="Graduated"
              value={fmtNum(graduates.length)}
              tone={graduates.length ? "accent" : "default"}
              hint="genomic → daughter-proven"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Top gainers (GTPI)">
              {gainers.length ? <MoverTable list={gainers} /> : <EmptyState message="No gainers this round." />}
            </Card>
            <Card title="Biggest drops (GTPI)">
              {drops.length ? <MoverTable list={drops} /> : <EmptyState message="No decliners this round." />}
            </Card>
          </div>

          {flagged.length > 0 && (
            <div className="mt-4">
              <Card title={`Notable movers — ${fmtNum(flagged.length)} bull${flagged.length === 1 ? "" : "s"} moved unusually on GTPI`}>
                <ul className="divide-y divide-slate-100 text-sm">
                  {flagged
                    .slice()
                    .sort((a, b) => Math.abs(b.z as number) - Math.abs(a.z as number))
                    .slice(0, 25)
                    .map((m) => (
                      <li key={m.animalId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                        <Link href={`/us/animals/${m.animalId}`} className="link font-medium">{m.name}</Link>
                        <span className="text-slate-500">
                          GTPI {fmtNum(m.previous)} → {fmtNum(m.latest)} ({signed(m.delta)}), {(m.z as number).toFixed(1)} SD
                          {" "}from a round averaging {signed(Math.round(mean))}
                        </span>
                      </li>
                    ))}
                </ul>
                <p className="mt-3 text-xs text-slate-500">
                  Unusual is measured against how this round&rsquo;s own cohort moved (mean {signed(Math.round(mean))},
                  SD {fmtNum(Math.round(sd))}), so the herd-wide shift sits in the mean and only the bulls that
                  moved differently are listed. Graduating bulls are excluded — see below.
                </p>
              </Card>
            </div>
          )}

          {graduates.length > 0 && (
            <div className="mt-4">
              <Card title={`Graduating bulls — ${fmtNum(graduates.length)} moved from genomic to daughter-proven`}>
                <p className="mb-3 text-sm text-slate-600">
                  These bulls received their first daughter-based evaluation this round. They move several times
                  further than an ordinary bull, and that is expected rather than surprising — so they are kept
                  out of the averages and the notable-movers list above. This is the largest genuine change on the
                  American side, and the one worth reading first.
                </p>
                <MoverTable list={topGraduates} showFlag={false} />
                {graduates.length > topGraduates.length && (
                  <p className="mt-3 text-xs text-slate-500">
                    Showing the {topGraduates.length} highest by new GTPI of {fmtNum(graduates.length)} graduates.
                  </p>
                )}
              </Card>
            </div>
          )}

          <p className="mt-4 text-xs text-slate-500">
            <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
            Association USA formula in force for each round. It is not an official Holstein Association USA
            publication and is typically within ±3 points of the published figure, so it is shown as a whole
            number. TPI is a registered trademark of Holstein Association USA. GTPI is computed for Holstein
            only, so this digest covers Holstein bulls. Only official triannual rounds are compared — monthly
            and weekly CDCB adds are provisional and are never read as a round.
          </p>
        </>
      )}
    </div>
  );
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
 */
async function loadDigest() {
  const rounds = await prisma.usEvaluation.groupBy({
    by: ["roundCode"],
    where: { runKind: "official", approvalStatus: "approved", roundCode: { not: null } },
    orderBy: { roundCode: "desc" },
    take: 2,
  });
  // roundCode is YYMM, so a lexical sort is a chronological one.
  const latestRound = rounds[0]?.roundCode ?? null;
  const previousRound = rounds[1]?.roundCode ?? null;
  if (!latestRound || !previousRound) {
    return { latestRound, previousRound, updated: 0, ordinary: [] as Mover[], graduates: [] as Mover[], mean: 0, sd: 0 };
  }

  const [latestRows, previousRows] = await Promise.all([
    prisma.usEvaluation.findMany({
      where: { roundCode: latestRound, runKind: "official", approvalStatus: "approved", tpi: { not: null } },
      // A bull can appear in both triannual families for one round with identical
      // values; ordering by family makes the de-duplication below deterministic
      // and prefers the daughter-proven publication.
      orderBy: { sourceFamily: "asc" },
      select: {
        animalId: true, tpi: true, isGraduation: true, naabCode: true, evalBreed: true,
        animal: { select: { primaryName: true } },
      },
    }),
    prisma.usEvaluation.findMany({
      where: { roundCode: previousRound, runKind: "official", approvalStatus: "approved", tpi: { not: null } },
      orderBy: { sourceFamily: "asc" },
      select: { animalId: true, tpi: true },
    }),
  ]);

  const previousTpi = new Map<string, number>();
  for (const r of previousRows) if (r.tpi != null && !previousTpi.has(r.animalId)) previousTpi.set(r.animalId, r.tpi);

  const seen = new Set<string>();
  const movers: Mover[] = [];
  let updated = 0;
  for (const r of latestRows) {
    if (seen.has(r.animalId)) continue;
    seen.add(r.animalId);
    updated++;
    const previous = previousTpi.get(r.animalId);
    if (previous == null || r.tpi == null) continue;
    movers.push({
      animalId: r.animalId,
      name: r.animal.primaryName,
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
  if (n >= 3 && sd > 0) for (const m of ordinary) m.z = (m.delta - mean) / sd;

  return { latestRound, previousRound, updated, ordinary, graduates, mean, sd };
}
