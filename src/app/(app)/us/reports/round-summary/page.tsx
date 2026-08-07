import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, StatCard, EmptyState, Badge, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import {
  getUsRoundSummary, isUnusualMover, SD_MULT, TOP_MOVER_LIMIT, LIST_LIMIT,
  type Mover,
} from "@/lib/us-cdcb/round-summary";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// "What changed this round" — the American digest, read from UsEvaluation only.
// Never GeneticEvaluation: a Lactanet EBV in kg landing in a column headed GTPI
// would be the worst bug this product could ship.
//
// The digest itself — the rounds, the movers, the cohort statistics and every
// ordering — is built by getUsRoundSummary() in src/lib/us-cdcb/round-summary.ts,
// whose header carries the reasoning: only official rounds count, graduating
// bulls are held out of every statistic, and GTPI is ours rather than CDCB's.
// It lives there because this page, its Excel export and its emailable HTML
// export all render that ONE object, so a figure on screen and the same figure in
// a customer's attachment cannot disagree. Anything recomputed here would be a
// fourth opinion.
//
// All this file decides is presentation, and how far down each already-ordered
// list to go.
// ---------------------------------------------------------------------------

const signed = (n: number | null | undefined) =>
  n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(Math.round(n)))}`;

export default async function UsRoundSummaryPage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  // The US tables are created by `prisma db push`. Until that has run they do not
  // exist, and getUsRoundSummary reports that rather than throwing — a setup
  // state, not a fault, so it gets an explanation instead of a 500.
  const data = await getUsRoundSummary();

  if (data.missingTables) {
    return (
      <div>
        <PageHeader title="What changed this round" subtitle="CDCB evaluations" />
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
          <p className="mt-3 text-sm text-slate-600">Then import at least two CDCB rounds:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      </div>
    );
  }

  // Two official rounds are the minimum: one round on its own has nothing to
  // have changed FROM, and a provisional add is not a substitute for one.
  if (!data.latestRound || !data.previousRound) {
    return (
      <div>
        <PageHeader
          title="What changed this round"
          subtitle={
            data.latestRound
              ? `${data.latestLabel} is the only official round on file.`
              : "CDCB evaluations — April / August / December"
          }
        />
        <EmptyState message="No round-over-round movement to summarise yet — two official CDCB rounds are needed. Monthly and weekly adds are provisional and are never compared as rounds." />
      </div>
    );
  }

  // Every list arrives already ordered by the report. All the page decides is how
  // far down each one to go — and it says so wherever the cut is visible. The
  // exports read the same lists and go further.
  const { latestLabel, previousLabel, updated, ordinary, graduates, mean, sd, avg, up, down, flagged } = data;
  const gainers = data.gainers.slice(0, TOP_MOVER_LIMIT);
  const drops = data.drops.slice(0, TOP_MOVER_LIMIT);
  const topGraduates = graduates.slice(0, LIST_LIMIT);

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
        <tr key={m.usAnimalId} className="hover:bg-slate-50">
          <td className="td">
            <Link href={`/us/animals/${m.usAnimalId}`} className="link font-medium">{m.name}</Link>
            {m.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {m.naabCode}</span>}
            {showFlag && isUnusualMover(m) && (
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
            {latestLabel} <Badge tone="blue">Official</Badge> — each bull&rsquo;s{" "}
            <strong>calculated</strong> GTPI against its {previousLabel} figure.
          </span>
        }
        actions={
          <div className="flex gap-2">
            <a href="/us/reports/round-summary/export" className="btn-primary">⬇ Excel</a>
            <a
              href="/us/reports/round-summary/export?format=html"
              className="btn-secondary"
              title="A single self-contained file you can email — opens in any browser, no login needed. Carries the pounds, calculated-GTPI and trademark notes with it."
            >
              ⬇ HTML
            </a>
          </div>
        }
      />

      {ordinary.length === 0 && graduates.length === 0 ? (
        <EmptyState message="No bull carries a calculated GTPI in both rounds, so there is no movement to report. GTPI is computed for Holstein only." />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Bulls updated" value={fmtNum(updated)} hint={`GTPI in ${latestLabel}`} />
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
                    .slice(0, LIST_LIMIT)
                    .map((m) => (
                      <li key={m.usAnimalId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                        <Link href={`/us/animals/${m.usAnimalId}`} className="link font-medium">{m.name}</Link>
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
