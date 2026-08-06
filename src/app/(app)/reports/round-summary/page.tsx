import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, StatCard, EmptyState, Badge } from "@/components/ui";
import { getProofChangeReport, periodKey, type ReportRow } from "@/lib/proof-change";
import { fmtNum } from "@/lib/format";

export const dynamic = "force-dynamic";

// "What changed this round" — a lineup-level digest of the most recent proof round
// versus each bull's previous official proof. Built on getProofChangeReport (so
// official/interim handling is shared, not duplicated) with the "to" side pinned to
// the newest round, so it shows exactly the bulls that were updated this round.

const lpiOf = (r: ReportRow) => r.change.keyChanges.find((c) => c.code === "LPI");
const signed = (n: number | null | undefined) => (n == null ? "—" : `${n > 0 ? "+" : ""}${fmtNum(Math.round(n))}`);

export default async function RoundSummaryPage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  // The newest approved round overall (evaluationDate is the 1st of the run month).
  const latestEval = await prisma.geneticEvaluation.findFirst({
    where: { approvalStatus: "approved" },
    orderBy: { evaluationDate: "desc" },
    select: { evaluationDate: true },
  });
  const latestKey = latestEval ? periodKey(latestEval.evaluationDate) : "";

  const report = latestKey ? await getProofChangeReport({ to: latestKey }) : null;
  const roundLabel = report?.periods.find((p) => p.key === latestKey)?.label ?? "—";
  const roundOfficial = report?.periods.find((p) => p.key === latestKey)?.official ?? false;

  const rows = (report?.rows ?? []).filter((r) => r.change.lpiDelta != null);
  const deltas = rows.map((r) => r.change.lpiDelta as number);
  const avg = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  const up = deltas.filter((d) => d > 0).length;
  const down = deltas.filter((d) => d < 0).length;
  const gainers = [...rows].sort((a, b) => (b.change.lpiDelta as number) - (a.change.lpiDelta as number)).slice(0, 10);
  const decliners = [...rows].sort((a, b) => (a.change.lpiDelta as number) - (b.change.lpiDelta as number)).slice(0, 10).filter((r) => (r.change.lpiDelta as number) < 0);
  const significant = (report?.rows ?? []).filter((r) => r.change.keyFlaggedCount > 0);

  const MoverTable = ({ list }: { list: ReportRow[] }) => (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2 font-semibold">Bull</th>
            <th className="px-3 py-2 text-right font-semibold">Previous</th>
            <th className="px-3 py-2 text-right font-semibold">Latest</th>
            <th className="px-3 py-2 text-right font-semibold">LPI Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {list.map((r) => {
            const lpi = lpiOf(r);
            const d = r.change.lpiDelta as number;
            return (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <Link href={`/animals/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>
                  {r.change.keyFlaggedCount > 0 && <span className="ml-2 align-middle"><Badge tone="amber">moved ≥{report?.sdMult} SD</Badge></span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNum(lpi?.previous ?? null)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNum(lpi?.latest ?? null)}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${d > 0 ? "text-emerald-700" : d < 0 ? "text-red-600" : "text-slate-500"}`}>{signed(d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="What changed this round"
        subtitle={
          <span>
            {roundLabel}{" "}
            {roundOfficial ? <Badge tone="blue">Official</Badge> : <Badge>Interim</Badge>}{" "}
            — each bull's latest proof versus its previous official proof.
          </span>
        }
      />

      {!report || rows.length === 0 ? (
        <EmptyState message="No round-over-round movement to summarise yet — at least two proof rounds are needed." />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Bulls updated" value={fmtNum(report.compared)} hint={`in ${roundLabel}`} />
            <StatCard label="Avg LPI move" value={signed(avg)} tone={avg != null && avg >= 0 ? "good" : "warn"} hint="across updated bulls" />
            <StatCard label="Up / Down" value={`${up} / ${down}`} hint="LPI gained vs lost" />
            <StatCard label="Notable movers" value={fmtNum(significant.length)} tone={significant.length ? "accent" : "default"} hint={`≥${report.sdMult} SD on a key trait`} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Top gainers (LPI)">
              {gainers.length ? <MoverTable list={gainers} /> : <EmptyState message="No gainers this round." />}
            </Card>
            <Card title="Biggest drops (LPI)">
              {decliners.length ? <MoverTable list={decliners} /> : <EmptyState message="No decliners this round." />}
            </Card>
          </div>

          {significant.length > 0 && (
            <div className="mt-4">
              <Card title={`Notable movers — ${significant.length} bull${significant.length === 1 ? "" : "s"} moved unusually on a key trait`}>
                <ul className="divide-y divide-slate-100 text-sm">
                  {significant.slice(0, 25).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                      <Link href={`/animals/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>
                      <span className="text-slate-500">{r.change.summary}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}

          <p className="mt-4 text-xs text-slate-400">
            Compared against {report.cohortLabel}. Full trait-by-trait detail is on the{" "}
            <Link href="/reports/proof-changes" className="underline">Proof Change Report</Link>.
          </p>
        </>
      )}
    </div>
  );
}
