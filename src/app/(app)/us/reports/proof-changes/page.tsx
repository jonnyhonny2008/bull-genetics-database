import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, StatCard, Badge, EmptyState, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import {
  getUsProofChangeReport,
  US_CHANGE_KEY_TRAITS,
  US_RANKABLE_CHANGE_TRAITS,
  SD_LEVELS,
  MAX_ROWS,
  MIN_COHORT,
  formatUsDelta,
  type UsTraitChange,
} from "@/lib/us-cdcb/proof-change";

export const dynamic = "force-dynamic";

// How each bull moved between two CDCB rounds. Reads UsEvaluation only — a
// Canadian EBV in kilograms appearing in one of these columns would read as an
// American PTA in pounds and be roughly double the truth.
//
// Every round on this side is official (one CDCB file per round), so unlike the
// Canadian report there is no official-vs-interim choice to make or explain.

export default async function UsProofChangesPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/us/dashboard");

  const report = await getUsProofChangeReport(searchParams);

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...searchParams, ...over })) {
      if (v !== undefined && v !== "") p.set(k, String(v));
    }
    const s = p.toString();
    return `/us/reports/proof-changes${s ? `?${s}` : ""}`;
  };

  // The exports run the SAME builder over the SAME query string, so a download is
  // the view on screen — including the round pair, the sensitivity and the breed,
  // which re-bases the comparison group rather than merely hiding rows.
  const exportParams = new URLSearchParams();
  for (const k of ["from", "to", "q", "breed", "significant", "grads", "sd", "sort", "dir"]) {
    const v = searchParams[k];
    if (v) exportParams.set(k, v);
  }
  const exportQs = exportParams.toString();
  const exportHref = `/us/reports/proof-changes/export${exportQs ? `?${exportQs}` : ""}`;
  const htmlHref = `/us/reports/proof-changes/export?${exportQs ? `${exportQs}&` : ""}format=html`;

  if (report.missingTables) {
    return (
      <div>
        <PageHeader title="US Proof Change Report" subtitle="CDCB round-over-round movement" />
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
          <p className="mt-3 text-sm text-slate-600">Then import at least two CDCB rounds — this report compares one against another:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      </div>
    );
  }

  if (report.notEnoughRounds) {
    return (
      <div>
        <PageHeader title="US Proof Change Report" subtitle="CDCB round-over-round movement" />
        <Card title="Not enough rounds to compare">
          <EmptyState message={
            report.rounds.length === 0
              ? "No official CDCB rounds have been imported yet. Import a triannual round (April, August or December) to begin."
              : `Only one official round is on file (${report.rounds[0].label}). A change report needs two.`
          } />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="US Proof Change Report"
        subtitle={`How each bull moved from ${report.fromLabel} to ${report.toLabel}. CDCB PTAs in pounds; every round here is official.`}
        actions={
          <div className="flex gap-2">
            <a href={exportHref} className="btn-primary">⬇ Excel</a>
            <a
              href={htmlHref}
              className="btn-secondary"
              title="A single self-contained file you can email — opens in any browser, no login needed. Carries the pounds, calculated-GTPI and trademark notes with it."
            >
              ⬇ HTML
            </a>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Bulls compared"
          value={fmtNum(report.compared)}
          hint={report.notComparable ? `${fmtNum(report.notComparable)} new in ${report.toLabel}` : undefined}
          tone="good"
        />
        <StatCard
          label="Unusual movers"
          value={fmtNum(report.significantCount)}
          hint="≥1 key trait past the bar"
          tone={report.significantCount ? "warn" : "default"}
        />
        <StatCard
          label="Graduations"
          value={fmtNum(report.graduationCount)}
          hint="first daughter proof — never flagged"
          tone={report.graduationCount ? "accent" : "default"}
        />
        <StatCard
          label="Sensitivity"
          value={report.sdMult <= 0.5 ? "sensitive" : report.sdMult <= 1 ? "balanced" : "big movers"}
          hint={`unusual vs ${report.cohortLabel}`}
        />
      </div>

      {/* Which two rounds. Defaults to the newest round against the one before
          it; both sides can be pinned to compare any pair on file. */}
      <form method="get" className="card card-pad mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="from">Compare from</label>
          <select id="from" name="from" defaultValue={report.from} className="input min-w-[190px]">
            {report.rounds.map((r) => (
              <option key={r.roundCode} value={r.roundCode}>{r.label} ({fmtNum(r.rows)})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="to">Compare to</label>
          <select id="to" name="to" defaultValue={report.to} className="input min-w-[190px]">
            {report.rounds.map((r) => (
              <option key={r.roundCode} value={r.roundCode}>{r.label} ({fmtNum(r.rows)})</option>
            ))}
          </select>
        </div>
        {/* Carry the rest so changing rounds does not reset the view. */}
        {report.q && <input type="hidden" name="q" value={report.q} />}
        {report.breed && <input type="hidden" name="breed" value={report.breed} />}
        {report.significantOnly && <input type="hidden" name="significant" value="1" />}
        {report.grads !== "show" && <input type="hidden" name="grads" value={report.grads} />}
        <input type="hidden" name="sd" value={String(report.sdMult)} />
        <input type="hidden" name="sort" value={report.sort} />
        <input type="hidden" name="dir" value={report.dir} />
        <button type="submit" className="btn-primary">Compare rounds</button>
      </form>

      <form method="get" className="card card-pad mt-3 flex flex-wrap items-end gap-3">
        <input type="hidden" name="from" value={report.from} />
        <input type="hidden" name="to" value={report.to} />
        <div>
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={report.q} placeholder="Name, NAAB, or 17-char ID…" className="input min-w-[200px]" />
        </div>
        <div>
          <label className="label" htmlFor="breed" title="Breed also re-bases the comparison group the flag is measured against.">Breed</label>
          <select id="breed" name="breed" defaultValue={report.breed} className="input">
            <option value="">All breeds</option>
            {report.breeds.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sort">Sort by</label>
          {/* Rump angle is absent by construction: with an intermediate optimum,
              "biggest movement" in it has no favourable direction to order by. */}
          <select id="sort" name="sort" defaultValue={report.sort} className="input">
            {US_RANKABLE_CHANGE_TRAITS.filter((t) => t.key).map((t) => (
              <option key={t.code} value={t.code.toLowerCase()}>{t.short} change</option>
            ))}
            <option value="flags">Traits flagged</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="dir">Order</label>
          <select id="dir" name="dir" defaultValue={report.dir} className="input">
            <option value="desc">Biggest first</option>
            <option value="asc">Smallest first</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sd" title={`A trait is flagged when its change is this many standard deviations from how ${report.cohortLabel} moved on that trait.`}>Sensitivity</label>
          <select id="sd" name="sd" defaultValue={String(report.sdMult)} className="input">
            {SD_LEVELS.map((s) => (
              <option key={s} value={s}>{s} SD {s === 0.5 ? "(sensitive)" : s === 1 ? "(balanced)" : "(big movers)"}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="grads" title="Graduating bulls move about six times a normal round, so they are held out of the statistics either way. This only controls whether their rows are listed.">Graduations</label>
          <select id="grads" name="grads" defaultValue={report.grads} className="input">
            <option value="show">Show, unflagged</option>
            <option value="only">Graduations only</option>
            <option value="hide">Hide</option>
          </select>
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Only bulls where at least one of the seven key traits cleared the threshold.">
          <input type="checkbox" name="significant" value="1" defaultChecked={report.significantOnly} />
          Only unusual movers
        </label>
        <button type="submit" className="btn-primary">Apply</button>
        <a href="/us/reports/proof-changes" className="btn-secondary">Reset</a>
      </form>

      <div className="mt-4">
        {report.rows.length === 0 ? (
          <Card title="Proof changes">
            <EmptyState message={
              report.compared === 0
                ? `No bull has an official evaluation in both ${report.fromLabel} and ${report.toLabel}. Pick another pair of rounds.`
                : "No bulls match the current filters. Widen the search or clear the filters."
            } />
          </Card>
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              Showing {fmtNum(report.rows.length)} of {fmtNum(report.shown)} matching bulls
              ({fmtNum(report.compared)} compared in total). Green = moved favourably, red = moved
              unfavourably, and a <strong className="rounded bg-amber-100 px-1 text-amber-900">highlighted</strong> figure
              is an <strong>unusual mover</strong>: it moved further than {report.cohortLabel} did on that trait, by the
              Sensitivity set above. The flag is relative to that group by design — filtering to one breed re-bases the
              mean and spread, so the same bull can be flagged in one view and not another.
              Graduating bulls are excluded from that mean and are never flagged.
              Only the seven key traits decide whether a bull counts as an unusual mover.
            </p>
            {report.cohortTooSmall && (
              <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                Only {fmtNum(report.cohortN)} non-graduating bull{report.cohortN === 1 ? "" : "s"} in {report.cohortLabel} —
                at least {MIN_COHORT} are needed to measure a spread, so nothing can be flagged and every Flags count reads 0.
                The changes below are still real.
              </p>
            )}

            <div className="card">
              <Table head={<>
                <th className="th">
                  <Link href={qs({ sort: "name", dir: report.sort === "name" && report.dir === "asc" ? "desc" : "asc" })} className="hover:underline">
                    Bull{report.sort === "name" ? (report.dir === "desc" ? " ↓" : " ↑") : ""}
                  </Link>
                </th>
                <th className="th">Breed</th>
                {US_CHANGE_KEY_TRAITS.map((t) => (
                  <th key={t.code} className="th text-right">
                    {t.direction === "intermediate" ? (
                      <span title={`${t.label} — intermediate optimum, so its change is shown but never ranked or judged`}>
                        {t.short} Δ
                      </span>
                    ) : (
                      <Link
                        href={qs({ sort: t.code.toLowerCase(), dir: report.sort === t.code.toLowerCase() && report.dir === "desc" ? "asc" : "desc" })}
                        title={`${t.label} — sorted on the size of the move, up or down`}
                        className="hover:underline"
                      >
                        {t.short} Δ{report.sort === t.code.toLowerCase() ? (report.dir === "desc" ? " ↓" : " ↑") : ""}
                      </Link>
                    )}
                  </th>
                ))}
                <th className="th text-right">
                  <Link href={qs({ sort: "flags", dir: report.sort === "flags" && report.dir === "desc" ? "asc" : "desc" })} className="hover:underline">
                    Flags{report.sort === "flags" ? (report.dir === "desc" ? " ↓" : " ↑") : ""}
                  </Link>
                </th>
              </>}>
                {report.rows.map((r) => (
                  <tr key={r.animalId} className="align-top hover:bg-slate-50">
                    <td className="td">
                      <Link href={`/us/animals/${r.animalId}`} className="link font-medium">{r.name}</Link>
                      {r.graduated && <span className="ml-1.5"><Badge tone="orange">graduation</Badge></span>}
                      <span className="mt-0.5 block font-mono text-[10px] text-slate-400">
                        {r.naab ? `NAAB ${r.naab}` : r.id17}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">{r.change.summary}</span>
                      {r.change.otherFlagged.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700">
                            {r.change.otherFlagged.length} other trait{r.change.otherFlagged.length === 1 ? "" : "s"} moved unusually
                          </summary>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {r.change.otherFlagged.map((c) => (
                              <span key={c.code} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                                {c.short} {formatUsDelta(c)}
                              </span>
                            ))}
                          </div>
                        </details>
                      )}
                    </td>
                    <td className="td text-xs text-slate-500">{r.breed ?? "—"}</td>
                    {US_CHANGE_KEY_TRAITS.map((t) => {
                      const c = r.change.changes.find((x) => x.code === t.code);
                      return <td key={t.code} className="td text-right tabular-nums">{c ? <DeltaCell c={c} /> : "—"}</td>;
                    })}
                    <td className="td text-right text-xs">
                      {r.graduated ? (
                        <span className="text-slate-400" title="A graduating bull is expected to move; he is held out of the statistics and never flagged.">n/a</span>
                      ) : r.change.keyFlaggedCount ? (
                        <Badge tone="amber">{r.change.keyFlaggedCount}</Badge>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>

            {report.shown > MAX_ROWS && (
              <p className="mt-2 text-xs text-slate-500">
                Showing the {MAX_ROWS} biggest movers of {fmtNum(report.shown)} matching bulls. Narrow the search or breed to see
                further down the list — the comparison group behind the flag is unaffected by this cap.
              </p>
            )}
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500">
        <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
        Association USA formula in force for each round. It is not an official Holstein Association USA
        publication and is typically within ±3 points of the published figure, so its change is shown as a
        whole number. TPI is a registered trademark of Holstein Association USA. <strong>Rump Angle has an
        intermediate optimum</strong> — its change is shown but never ranked or called favourable, because
        neither the highest nor the lowest value is best. All yield values are PTAs in pounds.
      </p>
    </div>
  );
}

/**
 * One delta. Colour carries direction, not size — and an intermediate-optimum
 * trait gets no colour at all, since a move up in rump angle is not a move up in
 * merit and colouring it green would say otherwise.
 */
function DeltaCell({ c }: { c: UsTraitChange }) {
  if (c.delta == null) return <span className="text-slate-300">—</span>;
  const tone =
    c.favourable === true ? "text-emerald-700"
    : c.favourable === false ? "text-red-600"
    : "text-slate-600";
  const title = [
    `${c.label}: ${c.previous ?? "—"} → ${c.latest ?? "—"}`,
    c.direction === "intermediate" ? "Intermediate optimum — direction not judged" : null,
    c.z != null ? `${c.z} SD from the comparison group` : null,
  ].filter(Boolean).join(" · ");
  return (
    <span className={`${tone} ${c.flagged ? "rounded bg-amber-100 px-1 font-semibold text-amber-900" : ""}`} title={title}>
      {formatUsDelta(c)}
    </span>
  );
}
