import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, EmptyState, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { listUsPeriods, getUsRoundCompare } from "@/lib/us-cdcb/round-compare";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";
import { US_GTPI_NOTE, US_TPI_TRADEMARK, US_POUNDS_NOTE, US_RPA_NOTE } from "@/lib/us-cdcb/report-notes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const sign = (v: number, dp: number) => `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;

export default async function UsRoundComparePage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  let periods: Awaited<ReturnType<typeof listUsPeriods>> = [];
  let missingTables = false;
  try {
    periods = await listUsPeriods();
  } catch (e) {
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) missingTables = true;
    else throw e;
  }

  const breed = (searchParams.breed ?? "").toUpperCase();
  const keys = periods.map((p) => p.periodKey);
  const to = keys.includes(searchParams.to ?? "") ? searchParams.to! : (keys[0] ?? "");
  const from = keys.includes(searchParams.from ?? "") ? searchParams.from! : (keys[1] ?? "");

  const report = from && to && from !== to
    ? await getUsRoundCompare({ from, to, breed: breed || undefined })
    : null;

  const qp = new URLSearchParams({ from, to, ...(breed ? { breed } : {}) });
  const csvHref = `/us/reports/round-compare/export?${qp}&format=csv`;
  const htmlHref = `/us/reports/round-compare/export?${qp}&download=1`;

  return (
    <div>
      <PageHeader
        title="Round Comparison — CDCB"
        subtitle="How the American evaluations moved between any two CDCB periods on file. Every figure is computed per breed, because CDCB re-bases each breed separately."
        actions={
          report ? (
            <div className="flex gap-2">
              <a href={csvHref} className="btn-primary">⬇ CSV</a>
              <a href={htmlHref} className="btn-secondary" title="A single self-contained file you can email — opens in any browser, no login needed">⬇ HTML</a>
            </div>
          ) : undefined
        }
      />

      {missingTables ? (
        <Card title="The American tables have not been created yet">
          <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
        </Card>
      ) : periods.length < 2 ? (
        <Card title="Round Comparison">
          <EmptyState message={`Two CDCB periods must be on file to compare — ${periods.length} ${periods.length === 1 ? "is" : "are"} loaded so far. Import another round to use this report.`} />
        </Card>
      ) : (
        <>
          <form method="get" className="card card-pad flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="from">From period</label>
              <select id="from" name="from" defaultValue={from} className="input min-w-[220px]">
                {periods.map((p) => <option key={p.periodKey} value={p.periodKey}>{p.label} · {p.runKind} · {fmtNum(p.animals)}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="to">To period</label>
              <select id="to" name="to" defaultValue={to} className="input min-w-[220px]">
                {periods.map((p) => <option key={p.periodKey} value={p.periodKey}>{p.label} · {p.runKind} · {fmtNum(p.animals)}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="breed">Breed</label>
              <select id="breed" name="breed" defaultValue={breed} className="input">
                <option value="">All breeds</option>
                {CDCB_BREEDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <button type="submit" className="btn-primary">Compare</button>
          </form>

          <div className="mt-4 space-y-4">
            {from === to ? (
              <Card title="Round Comparison"><EmptyState message="Pick two different periods." /></Card>
            ) : !report ? (
              <Card title="Round Comparison"><EmptyState message="Nothing to compare for that selection." /></Card>
            ) : (
              <>
                {report.mixedRunKinds && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <strong>These two periods are not peers.</strong> {report.mixedRunKinds}
                  </div>
                )}

                {report.breeds.length === 0 ? (
                  <Card title="No bull appears in both periods">
                    <EmptyState message={`No animal is present in both ${report.from.label} and ${report.to.label}${breed ? ` for ${breed}` : ""}, so there is nothing to compare. Arrivals and departures are not movement.`} />
                  </Card>
                ) : (
                  report.breeds.map((b) => (
                    <Card key={b.breed} title={`${b.breed} — ${fmtNum(b.common)} bull${b.common === 1 ? "" : "s"} in both periods`}>
                      <p className="mb-3 text-xs text-slate-500">
                        {fmtNum(b.arrived)} arrived in {report.to.label} and {fmtNum(b.departed)} were not carried forward from {report.from.label}.
                        Neither counts as movement — only the {fmtNum(b.common)} present in both are compared.
                      </p>
                      <Table head={<>
                        <th className="th">Trait</th>
                        <th className="th text-right">n</th>
                        <th className="th text-right">{report.from.label}</th>
                        <th className="th text-right">{report.to.label}</th>
                        <th className="th text-right">Mean move</th>
                        <th className="th text-right">SD</th>
                        <th className="th text-right">Up / down / same</th>
                      </>}>
                        {b.traits.map((t) => (
                          <tr key={t.code} className="hover:bg-slate-50">
                            <td className="td">
                              {t.label}
                              {t.unit && <span className="ml-1 text-xs text-slate-400">{t.unit}</span>}
                              {t.intermediate && (
                                <span
                                  className="ml-2 rounded bg-slate-200 px-1 text-[9px] font-bold uppercase tracking-wide text-slate-600"
                                  title="Intermediate optimum — the middle of the scale is the target, so a mean move is not progress in either direction"
                                >
                                  opt
                                </span>
                              )}
                            </td>
                            <td className="td text-right tabular-nums text-slate-500">{fmtNum(t.n)}</td>
                            <td className="td text-right tabular-nums text-slate-500">{t.meanFrom.toFixed(t.decimals)}</td>
                            <td className="td text-right tabular-nums text-slate-500">{t.meanTo.toFixed(t.decimals)}</td>
                            <td className={`td text-right font-semibold tabular-nums ${t.intermediate ? "text-slate-600" : t.meanDelta > 0 ? "text-brand-700" : t.meanDelta < 0 ? "text-red-600" : "text-slate-500"}`}>
                              {sign(t.meanDelta, t.decimals)}
                            </td>
                            <td className="td text-right tabular-nums text-slate-400">{t.sdDelta.toFixed(t.decimals)}</td>
                            <td className="td text-right text-xs tabular-nums text-slate-500">
                              {fmtNum(t.rose)} / {fmtNum(t.fell)} / {fmtNum(t.unchanged)}
                            </td>
                          </tr>
                        ))}
                      </Table>
                    </Card>
                  ))
                )}

                {report.topRisers.length > 0 && (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <MoverCard title="Biggest risers on the lead index" rows={report.topRisers} />
                    <MoverCard title="Biggest fallers on the lead index" rows={report.topFallers} />
                  </div>
                )}

                <Card title="How to read this">
                  <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
                    <li>Every figure is <strong>per breed</strong>. CDCB re-bases each breed on its own population, so an all-breed average would combine numbers that are not on the same scale.</li>
                    <li>Movers are ranked by how far they moved <strong>relative to their own breed&rsquo;s spread</strong>, not by raw points — 40 GTPI points in Holstein is not 40 JPI points in Jersey.</li>
                    <li>{US_RPA_NOTE}</li>
                    <li>{US_GTPI_NOTE} {US_TPI_TRADEMARK}</li>
                    <li>{US_POUNDS_NOTE}</li>
                  </ul>
                </Card>
              </>
            )}
          </div>
        </>
      )}

      <p className="mt-4 text-xs text-slate-400">
        <Link href="/us/reports" className="link">← All American reports</Link>
      </p>
    </div>
  );
}

function MoverCard({ title, rows }: { title: string; rows: Awaited<ReturnType<typeof getUsRoundCompare>> extends null ? never : NonNullable<Awaited<ReturnType<typeof getUsRoundCompare>>>["topRisers"] }) {
  return (
    <Card title={title}>
      <Table head={<>
        <th className="th">Bull</th>
        <th className="th">Breed</th>
        <th className="th text-right">Before</th>
        <th className="th text-right">After</th>
        <th className="th text-right">Move</th>
      </>}>
        {rows.map((m) => (
          <tr key={m.usAnimalId} className="hover:bg-slate-50">
            <td className="td">
              <Link href={`/us/animals/${m.usAnimalId}`} className="link font-medium">{m.name}</Link>
              {m.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {m.naabCode}</span>}
            </td>
            <td className="td text-xs text-slate-500">{m.breed ?? "—"}</td>
            <td className="td text-right tabular-nums text-slate-500">{m.from}</td>
            <td className="td text-right tabular-nums text-slate-700">{m.to}</td>
            <td className={`td text-right font-semibold tabular-nums ${m.delta > 0 ? "text-brand-700" : m.delta < 0 ? "text-red-600" : "text-slate-500"}`}>
              {m.delta > 0 ? `+${m.delta}` : m.delta}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
