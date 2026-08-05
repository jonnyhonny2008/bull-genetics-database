"use client";

import { useState } from "react";
import { Card, Table, Badge, EmptyState } from "@/components/ui";
import { fmtNum } from "@/lib/format";
// Type-only import: erased at compile time, so the server-only orchestrator
// never enters this client bundle.
import type { MatingReport, MatingFemale, MatingMatch, FemaleWeakness } from "@/lib/mating-program";
// mating-score is PURE (no server-only), so the constants that define the scale
// can be read here instead of being retyped into the copy and drifting.
import { MATCH_SCORE_DIGITS, SCORE_BASE } from "@/lib/mating-score";

/** One sentence, in the same words everywhere the Match score appears. Plain
 *  language on purpose — the score is relative to the bulls in this run, and
 *  higher is a better fit; the statistics behind it are not shown to staff. */
const SCORE_EXPLAINER = `${SCORE_BASE} = the average of the bulls in this run, higher is a better fit for her`;

/**
 * The Match score, at the one precision it is shown at anywhere.
 *
 * Whole numbers are wrong here: the ranking sorts on the unrounded composite, so
 * at 0 decimals a fifth of a standard deviation vanishes and rows 3, 4 and 5 all
 * read the same number in a numbered list. The Excel sheet writes the same 1-dp
 * figure; screen and workbook must not disagree. Trait values keep fmtNum's
 * 0-decimal default — that is the untouched single-trait presentation.
 */
const fmtScore = (n: number | null | undefined): string => fmtNum(n, MATCH_SCORE_DIGITS);

const pct = (n: number | null | undefined): string =>
  n === null || n === undefined || isNaN(n) ? "—" : `${Math.round(n * 100)}%`;

/** Tier vocabulary is shared with the engine; keep the colour mapping in one place. */
function TierBadge({ tier }: { tier: "clear" | "unknown" | "excluded" | "no-pedigree" }) {
  if (tier === "clear") return <Badge tone="green">Clear</Badge>;
  if (tier === "unknown") return <Badge tone="amber">Not checkable</Badge>;
  if (tier === "excluded") return <Badge tone="red">Excluded</Badge>;
  return <Badge tone="slate">No pedigree</Badge>;
}

/** Completeness chip. Below the floor this is the whole reason a bull is withheld. */
function CompleteChip({ value, floor }: { value: number; floor: number }) {
  const tone = value >= floor ? "green" : value > 0 ? "amber" : "slate";
  return <Badge tone={tone}>Checked {pct(value)}</Badge>;
}

/**
 * The female's best achievable calf index. Falls back to the bull's own index
 * when the dam carries no value for the chosen trait — the report never invents
 * a projection it cannot compute.
 */
function bestIndexOf(f: MatingFemale, scored: boolean): number | null {
  const top = f.matches[0];
  if (!top) return null;
  // A scored run is ranked on the Match score, so the headline figure is the
  // Match score. Showing the primary trait's PA there would name the top bull of
  // one ranking and the number of another.
  if (scored) return top.matchScore;
  return top.paIndex ?? top.ownIndex;
}

/**
 * True when the dam has no value for the ranked index, so nothing was averaged
 * and every figure in the ranking column is the BULL'S OWN number.
 *
 * Read from the server's own verdict. It must NOT be re-derived from
 * `paIndex === null`: the orchestrator drops every candidate with no value for
 * the chosen index before ranking, so paIndex is never null and any such test is
 * dead code — which is exactly how the column came to be headed "Projected calf
 * LPI" while showing raw bull LPIs.
 */
function damLacksIndex(f: MatingFemale): boolean {
  return f.paBasis === "bull-index";
}

export function MatingProgramResults({
  report,
  indexLabel,
}: {
  report: MatingReport;
  indexLabel: string;
}) {
  const [view, setView] = useState<"herd" | "female">("herd");
  const { females } = report;
  // A real multi-trait blend drives the blend-specific copy; `scored` (a blend
  // of traits OR corrective mating being active) drives whether a Match score
  // column is shown at all. A single-trait run against strong cows stays the
  // classic raw-value report.
  const multi = report.params.selected.length > 1;
  const scored = report.scored;

  if (females.length === 0) {
    return (
      <Card title="Mating program">
        <EmptyState message="Paste up to 50 female registration numbers above to generate recommendations." />
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setView("herd")}
          className={view === "herd" ? "btn-primary" : "btn-secondary"}
        >
          Herd summary
        </button>
        <button
          type="button"
          onClick={() => setView("female")}
          className={view === "female" ? "btn-primary" : "btn-secondary"}
        >
          Per female
        </button>
        <span className="text-xs text-slate-500">
          {fmtNum(females.length)} female{females.length === 1 ? "" : "s"} · ranked on {indexLabel}
          {scored && <> · Match score {SCORE_EXPLAINER}</>}
        </span>
      </div>

      {view === "herd" ? (
        <HerdSummary report={report} indexLabel={indexLabel} scored={scored} multi={multi} />
      ) : (
        <div className="space-y-3">
          {females.map((f, i) => (
            <FemaleCard
              key={`${f.input}-${i}`}
              female={f}
              indexLabel={indexLabel}
              scored={scored}
              multi={multi}
              strict={report.params.strictImprovers}
              // The bar actually applied. At depth 2 completeness is normalised
              // over two generations, so the floor is scaled to match; showing
              // params.floor here would colour chips against a bar nobody used.
              floor={report.effectiveFloor}
              defaultOpen={i === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- her weaknesses ---------------------------------------------------------

/** The faults the run is mating to correct, and the goal for each. The acted
 *  ones drive the never-worsen floor and the ranking; the rest are shown so the
 *  breeder can see what was noted but not acted on. */
function WeaknessPanel({ female: f, strict }: { female: MatingFemale; strict: boolean }) {
  const acted = f.weaknesses.filter((w) => w.acted);
  const noted = f.weaknesses.filter((w) => !w.acted);
  if (acted.length === 0 && noted.length === 0 && f.setbackTotal === 0) return null;

  const chip = (w: FemaleWeakness) => (
    <span
      key={w.code}
      className="inline-flex items-center gap-1 rounded border border-navy-200 bg-white px-1.5 py-0.5 text-[11px] text-navy-900"
      title={`She is ${fmtNum(w.cowValue)} — ${w.goal}${w.deep ? " (checked on the recommended bulls only)" : ""}`}
    >
      <span className="font-semibold">{w.label}</span>
      <span className="text-slate-500">{fmtNum(w.cowValue)}</span>
      {w.deep && <span className="text-slate-400" title="No indexed column — checked on the recommended bulls only">◇</span>}
    </span>
  );

  return (
    <div className="mb-3 rounded border border-navy-200 bg-navy-50 px-3 py-2 text-xs text-navy-900">
      {acted.length > 0 ? (
        <>
          <p className="mb-1.5">
            <strong>Mating to correct her weaknesses.</strong> Every recommended bull{" "}
            {strict ? (
              <>is <strong>positive</strong> for</>
            ) : (
              <>at least does not set back</>
            )}{" "}
            {acted.length === 1 ? "this trait" : "these traits"}; bulls that would are moved to{" "}
            <em>Set aside</em>. Bulls that fix the most rank first.
          </p>
          <div className="flex flex-wrap gap-1.5">{acted.map(chip)}</div>
        </>
      ) : (
        <p className="mb-0">
          <strong>No major weakness detected</strong> on the traits we track — ranked on merit, with the never-worsen
          floor still on.
        </p>
      )}
      {noted.length > 0 && (
        <div className="mt-2">
          <span className="text-slate-500">Also below average, not acted on: </span>
          <span className="flex flex-wrap gap-1.5 pt-1">{noted.map(chip)}</span>
        </div>
      )}
      {f.unassessedWeak.length > 0 && (
        <p className="mt-2 text-slate-500">
          Could not read {f.unassessedWeak.map((u) => u.label).join(", ")} for her — no value on file, so{" "}
          {f.unassessedWeak.length === 1 ? "it was" : "they were"} not screened.
        </p>
      )}
    </div>
  );
}

/** Small green pills naming the flagged faults this bull improves. */
function CorrectsBadges({ corrects }: { corrects: string[] }) {
  if (!corrects.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {corrects.map((c) => (
        <span key={c} className="rounded bg-green-50 px-1 py-0.5 text-[10px] font-medium text-green-700" title={`Improves her ${c}`}>
          ↑{c}
        </span>
      ))}
    </span>
  );
}

// --- view 1: herd summary ---------------------------------------------------

function HerdSummary({
  report,
  indexLabel,
  scored,
  multi,
}: {
  report: MatingReport;
  indexLabel: string;
  scored: boolean;
  multi: boolean;
}) {
  return (
    <Card title="Herd summary">
      {multi && (
        <p className="mb-2 text-xs text-slate-500">
          Ranked on <strong>{indexLabel}</strong>. The figure beside each bull is his <strong>Match score</strong> —{" "}
          {SCORE_EXPLAINER} — not a projected calf value. Open a female for the projected calf figure of each trait.
        </p>
      )}
      <Table
        head={
          <>
            <th className="th">Female</th>
            <th className="th">Reg</th>
            <th className="th">Pedigree</th>
            <th className="th">{scored ? "Top 3 bulls — match score" : `Top 3 bulls — projected calf ${indexLabel}`}</th>
            <th className="th text-right">Eligible</th>
            <th className="th text-right">Set aside</th>
            <th className="th text-right">Excluded</th>
            <th className="th text-right">Unverifiable</th>
          </>
        }
      >
        {report.females.map((f, i) => (
          <tr key={`${f.input}-${i}`} className="align-top">
            <td className="td font-medium text-slate-900">
              {f.name ?? f.input}
              {f.source === "lactanet" && (
                <span className="ml-1.5">
                  <Badge tone="blue">Lactanet — not saved</Badge>
                </span>
              )}
            </td>
            <td className="td font-mono text-xs text-slate-600">{f.reg ?? f.input}</td>
            <td className="td">
              {f.error ? <Badge tone="red">Failed</Badge> : <CompleteChip value={f.cowComplete} floor={report.effectiveFloor} />}
            </td>
            <td className="td">
              {f.error ? (
                <span className="text-xs text-red-700">{f.error}</span>
              ) : f.matches.length === 0 ? (
                <span className="text-xs text-slate-500">No eligible bulls.</span>
              ) : (
                <ol className="space-y-0.5 text-xs text-slate-700">
                  {f.matches.slice(0, 3).map((m, r) => (
                    <li key={m.bullId}>
                      <span className="text-slate-400">{r + 1}.</span> {m.name}{" "}
                      <span className="font-semibold text-brand-700">
                        {scored
                          ? fmtScore(m.matchScore)
                          : fmtNum(damLacksIndex(f) ? m.ownIndex : m.paIndex)}
                      </span>
                      {!scored && damLacksIndex(f) && <span className="text-slate-400"> (bull&rsquo;s own)</span>}
                      <CorrectsBadges corrects={m.corrects} />
                    </li>
                  ))}
                </ol>
              )}
            </td>
            <td className="td text-right">{f.error ? "—" : fmtNum(f.matches.length)}</td>
            <td className="td text-right" title="Cleared the pedigree screen but would set back a weakness">
              {f.error ? "—" : fmtNum(f.setbackTotal)}
            </td>
            <td className="td text-right">{f.error ? "—" : fmtNum(f.excludedTotal)}</td>
            <td className="td text-right">{f.error ? "—" : fmtNum(f.unknown.length)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// --- view 2: one card per female --------------------------------------------

function FemaleCard({
  female: f,
  indexLabel,
  scored,
  multi,
  strict,
  floor,
  defaultOpen,
}: {
  female: MatingFemale;
  indexLabel: string;
  scored: boolean;
  multi: boolean;
  strict: boolean;
  floor: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const best = bestIndexOf(f, scored);
  const fallback = damLacksIndex(f);
  // Which traits of the blend she has no value for. Per trait, because a dam
  // routinely carries an LPI and no Conformation.
  const gaps = f.traitColumns.filter((t) => t.basis === "bull-index");

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-800">{f.name ?? f.input}</span>
          <span className="font-mono text-xs text-slate-500">{f.reg ?? f.input}</span>
          {f.source === "lactanet" && <Badge tone="blue">Lactanet — not saved</Badge>}
          {f.source === "internal" && <Badge tone="slate">In database</Badge>}
          {!f.error && <CompleteChip value={f.cowComplete} floor={floor} />}
          {!f.error && f.weaknesses.some((w) => w.acted) && (
            <Badge tone="amber">{f.weaknesses.filter((w) => w.acted).length} weakness{f.weaknesses.filter((w) => w.acted).length === 1 ? "" : "es"}</Badge>
          )}
          {f.error && <Badge tone="red">No recommendations</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {f.basis && <span>Basis {f.basis}</span>}
          {f.reliability !== null && f.reliability !== undefined && <span>Rel {pct(f.reliability)}</span>}
          {best !== null && (
            <span className="text-sm font-semibold text-brand-700">
              {scored ? "Best match score" : fallback ? `Best bull ${indexLabel}` : `Best calf ${indexLabel}`}{" "}
              {scored ? fmtScore(best) : fmtNum(best)}
            </span>
          )}
          <span className="text-slate-400">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div className="card-pad">
          {/* FAIL CLOSED: a female whose pedigree could not be read produces no
              recommendations at all, never a reassuring empty exclusion list. */}
          {f.error ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{f.error}</div>
          ) : (
            <>
              <WeaknessPanel female={f} strict={strict} />

              {f.notes.length > 0 && (
                <ul className="mb-3 list-disc space-y-0.5 pl-5 text-xs text-slate-500">
                  {f.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}

              {multi ? (
                <>
                  <p className="mb-3 rounded border border-navy-200 bg-navy-50 px-2 py-1.5 text-xs leading-relaxed text-navy-900">
                    Ranked on <strong>{indexLabel}</strong>. Each trait was measured against the bull pool before the
                    two were blended, so the <strong>Match score</strong> reads {SCORE_EXPLAINER}. The trait columns
                    beside it are the projected calf figures and are <strong>not</strong> what the order is based on.
                  </p>
                  {gaps.length > 0 && (
                    <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                      She has no {gaps.map((g) => g.label).join(", ")} on record, so{" "}
                      {gaps.length === 1 ? "that column shows" : "those columns show"} each bull&rsquo;s own value
                      rather than a projected calf value. The Match score is unaffected — it is always built from the
                      bulls&rsquo; own numbers.
                    </p>
                  )}
                </>
              ) : (
                fallback && (
                  <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    She has no {indexLabel} on record, so no parent average can be computed for her. The trait column
                    below falls back to each bull&rsquo;s own {indexLabel} — it is <strong>not</strong> a projected calf
                    value.
                  </p>
                )
              )}

              {f.matches.length === 0 ? (
                <EmptyState message="No bull cleared the screen for this female at the current settings — check the Set aside, Excluded and unverifiable lists below." />
              ) : (
                <Table
                  head={
                    <>
                      <th className="th w-12">Rank</th>
                      <th className="th">Bull</th>
                      <th className="th">NAAB</th>
                      {scored ? (
                        <>
                          <th className="th text-right" title={`Match score — ${SCORE_EXPLAINER}`}>
                            Match score
                          </th>
                          {/* Each column is headed for THIS female: a trait she
                              has no value for cannot be averaged, and the server
                              already said so in the heading it built. */}
                          {f.traitColumns.map((t) => (
                            <th key={t.code} className="th text-right">
                              {t.heading}
                              {t.weight !== 1 && <span className="font-normal text-slate-400"> ×{t.weight}</span>}
                            </th>
                          ))}
                        </>
                      ) : (
                        <>
                          <th className="th text-right">Bull&rsquo;s own {indexLabel}</th>
                          {/* The server already decided what this column is and
                              labelled it; re-deriving it here is how the two came
                              to disagree. */}
                          <th className="th text-right">
                            {fallback ? f.indexLabel : `Projected calf ${indexLabel}`}
                          </th>
                        </>
                      )}
                      <th className="th">Tier</th>
                      <th className="th text-right">Checked</th>
                    </>
                  }
                >
                  {f.matches.map((m, i) => (
                    <MatchRow key={m.bullId} match={m} rank={i + 1} fallback={fallback} scored={scored} />
                  ))}
                </Table>
              )}

              {/* The disclosures. Each is the audit trail that makes a
                  recommendation defensible — always present, never gated. */}
              <div className="mt-4 space-y-2">
                <details className="rounded border border-amber-200 bg-amber-50">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-amber-900">
                    Set aside — {fmtNum(f.setbackTotal)} bull{f.setbackTotal === 1 ? "" : "s"} would set back a weakness
                  </summary>
                  <div className="border-t border-amber-200 bg-white px-3 py-2">
                    {f.setbackTotal === 0 ? (
                      <p className="text-xs text-slate-500">
                        No cleared bull would set back any of her flagged weaknesses.
                      </p>
                    ) : (
                      <>
                        <p className="mb-2 text-xs text-slate-500">
                          These bulls cleared the relatedness screen but were kept out of the recommendations because
                          they would {strict ? "not be positive for" : "set back"} one of her weaknesses. They are never
                          recommended.
                        </p>
                        <Table
                          head={
                            <>
                              <th className="th">Bull</th>
                              <th className="th">NAAB</th>
                              <th className="th">Why it was set aside</th>
                            </>
                          }
                        >
                          {f.setback.map((s) => (
                            <tr key={s.bullId}>
                              <td className="td">
                                {s.name}
                                {s.reg && <div className="font-mono text-[11px] text-slate-400">{s.reg}</div>}
                              </td>
                              <td className="td font-mono text-xs text-slate-600">{s.naab ?? "—"}</td>
                              <td className="td text-xs text-slate-600">{s.reasons.join("; ")}</td>
                            </tr>
                          ))}
                        </Table>
                        {f.setbackTotal > f.setback.length && (
                          <p className="mt-2 text-xs text-slate-500">
                            Showing {fmtNum(f.setback.length)} of {fmtNum(f.setbackTotal)}. Every set-aside bull is on
                            the Excel export.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </details>

                <details className="rounded border border-slate-200 bg-slate-50">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700">
                    Excluded — {fmtNum(f.excludedTotal)} bull{f.excludedTotal === 1 ? "" : "s"} share a registered
                    ancestor with her
                  </summary>
                  <div className="border-t border-slate-200 bg-white px-3 py-2">
                    {f.excludedTotal === 0 ? (
                      <p className="text-xs text-slate-500">
                        No bull in the pool shares a registered ancestor with her inside the screened generations.
                      </p>
                    ) : (
                      <Table
                        head={
                          <>
                            <th className="th">Bull</th>
                            <th className="th">Shared ancestor</th>
                            <th className="th">Reg</th>
                            <th className="th">Relationship</th>
                          </>
                        }
                      >
                        {f.excluded.map((x) =>
                          x.shared.map((s, j) => (
                            <tr key={`${x.bullId}-${s.reg}-${j}`}>
                              <td className="td">{j === 0 ? x.name : ""}</td>
                              <td className="td">{s.name ?? <span className="text-slate-400">unnamed</span>}</td>
                              <td className="td font-mono text-xs text-slate-600">{s.reg}</td>
                              <td className="td text-xs text-slate-600">
                                {s.label}{" "}
                                <span className="text-slate-400">
                                  (her gen {s.cowGen}, his gen {s.bullGen})
                                </span>
                              </td>
                            </tr>
                          )),
                        )}
                      </Table>
                    )}
                    {f.excludedTotal > f.excluded.length && (
                      <p className="mt-2 text-xs text-slate-500">
                        Showing the {fmtNum(f.excluded.length)} closest of {fmtNum(f.excludedTotal)}. Every excluded
                        bull, with its shared ancestor, is on the Excluded sheet of the Excel export.
                      </p>
                    )}
                  </div>
                </details>

                <details className="rounded border border-slate-200 bg-slate-50">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700">
                    Not enough pedigree to check — {fmtNum(f.unknown.length)} bull
                    {f.unknown.length === 1 ? "" : "s"} withheld
                  </summary>
                  <div className="border-t border-slate-200 bg-white px-3 py-2">
                    <p className="mb-2 text-xs text-slate-500">
                      These bulls showed no shared ancestor, but too little of the pedigree could be read to say so with
                      confidence. They are withheld from the ranking rather than demoted within it.
                    </p>
                    {f.unknown.length === 0 ? (
                      <p className="text-xs text-slate-500">Every bull in the pool was checkable.</p>
                    ) : (
                      <Table
                        head={
                          <>
                            <th className="th">Bull</th>
                            <th className="th text-right">Checked</th>
                            <th className="th text-right">Slots</th>
                            <th className="th">Why it could not be checked</th>
                          </>
                        }
                      >
                        {/* The reason is computed per pair by the engine and
                            names WHICH side is blind. Confidence is
                            min(cow, bull), so one thin female withholds every
                            bull — a fixed sentence about the bull's sire would
                            be false for every one of them. */}
                        {f.unknown.map((m) => (
                          <tr key={m.bullId}>
                            <td className="td">
                              {m.name}
                              {m.tier === "no-pedigree" && (
                                <span className="ml-1.5">
                                  <TierBadge tier="no-pedigree" />
                                </span>
                              )}
                            </td>
                            <td className="td text-right">{pct(m.confidence)}</td>
                            <td className="td text-right">{fmtNum(m.bullSlots)}/14</td>
                            <td className="td text-xs text-slate-600">{m.reason}</td>
                          </tr>
                        ))}
                      </Table>
                    )}
                  </div>
                </details>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MatchRow({
  match: m,
  rank,
  fallback,
  scored,
}: {
  match: MatingMatch;
  rank: number;
  fallback: boolean;
  scored: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Rank + Bull + NAAB, then either (own, projected) or (match score, one per
  // trait), then Tier + Checked.
  const columns = 3 + (scored ? 1 + m.traits.length : 2) + 2;
  return (
    <>
      <tr>
        <td className="td text-slate-400">{rank}</td>
        <td className="td">
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-left font-medium text-navy-800 hover:underline">
            {m.name}
          </button>
          <CorrectsBadges corrects={m.corrects} />
          {m.reg && <div className="font-mono text-[11px] text-slate-400">{m.reg}</div>}
        </td>
        <td className="td font-mono text-xs text-slate-600">{m.naab ?? "—"}</td>
        {scored ? (
          <>
            <td className="td text-right font-semibold text-brand-700">{fmtScore(m.matchScore)}</td>
            {m.traits.map((t) => (
              <td key={t.code} className="td text-right">{fmtNum(t.pa)}</td>
            ))}
          </>
        ) : (
          <>
            <td className="td text-right">{fmtNum(m.ownIndex)}</td>
            <td className="td text-right font-semibold text-brand-700">
              {fmtNum(fallback ? m.ownIndex : m.paIndex)}
            </td>
          </>
        )}
        <td className="td">
          <TierBadge tier={m.tier} />
        </td>
        <td className="td text-right text-xs text-slate-600">{pct(m.confidence)}</td>
      </tr>
      {open && (
        <tr className="bg-slate-50">
          <td className="td" />
          <td className="td" colSpan={columns - 1}>
            {m.pa.length === 0 ? (
              <p className="text-xs text-slate-500">No trait could be averaged — the pair share no trait in common.</p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                {m.pa.map((t) => (
                  <span key={t.code}>
                    <span className="text-slate-400">{t.label}</span> {fmtNum(t.value)}
                  </span>
                ))}
              </div>
            )}
            {m.unavailable.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-400">
                Not averaged (missing on one side): {m.unavailable.map((u) => u.label).join(", ")}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
