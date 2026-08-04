"use client";

// "Sires that move like him" — the panel inside a bull's row on the Proof
// Forecast report.
//
// Everything it shows is a description of the PAST. The copy below is written to
// make that unmissable, because a list of "similar" bulls beside a forecast is
// exactly the kind of thing a reader will take as a prediction if you let them.
// It is not one: the direction of the next proof is not forecastable (see
// proof-analogue.ts — eight methods, all beaten by "assume no change").

import Link from "next/link";
import { TraitTrendChart, OVERLAY_COLORS } from "./TraitTrendChart";
import { KEY_TRAITS } from "@/lib/key-traits";
// The sentinel comes from the PURE module, not from proof-forecast: that one
// imports a Prisma client, and a value import would drag it into the browser.
import { ALL_TRAITS, THIN_OVERLAP } from "@/lib/proof-similarity";
import type { SimilarPanel } from "@/lib/proof-forecast";

const TRAIT_OPTIONS = [
  ...KEY_TRAITS.map((t) => ({ value: t.code, label: t.label })),
  { value: ALL_TRAITS, label: "All nine key traits" },
];

const MODE_OPTIONS: { value: string; label: string; blurb: string }[] = [
  { value: "shape", label: "Shape", blurb: "the same rhythm of ups and downs, whatever the size of the moves" },
  { value: "magnitude", label: "Magnitude", blurb: "the same rhythm AND the same amounts" },
];

/** Build a link that keeps every other bit of report state intact. */
function hrefWith(base: string, params: Record<string, string>, over: Record<string, string>, anchor: string) {
  const p = new URLSearchParams(params);
  for (const [k, v] of Object.entries(over)) p.set(k, v);
  return `${base}?${p.toString()}#${anchor}`;
}

export function SimilarSiresPanel({
  data, basePath, params,
}: {
  data: SimilarPanel;
  basePath: string;
  /** Current report state (filters, sort) so the controls do not drop it. */
  params: Record<string, string>;
}) {
  const anchor = `bull-${data.bullId}`;
  const link = (over: Record<string, string>) => hrefWith(basePath, params, { similar: data.bullId, ...over }, anchor);
  const combined = data.trait === ALL_TRAITS;

  return (
    <div className="mt-2 rounded-md bg-white p-3 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700">Sires that move like him</div>
        <Link href={hrefWith(basePath, params, {}, anchor)} className="text-[10px] text-slate-400 hover:text-slate-600">
          close
        </Link>
      </div>

      {/* --- controls --------------------------------------------------- */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-slate-400">Trait:</span>
          {TRAIT_OPTIONS.map((t) => (
            <Link
              key={t.value}
              href={link({ simTrait: t.value })}
              className={`rounded px-1.5 py-0.5 ${t.value === data.trait ? "bg-brand-600 font-semibold text-white" : "text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
            >
              {t.label}
            </Link>
          ))}
        </span>
        <span className="flex items-center gap-1">
          <span className="text-slate-400">Match on:</span>
          {MODE_OPTIONS.map((m) => (
            <Link
              key={m.value}
              href={link({ simMode: m.value })}
              title={m.blurb}
              className={`rounded px-1.5 py-0.5 ${m.value === data.mode ? "bg-brand-600 font-semibold text-white" : "text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
            >
              {m.label}
            </Link>
          ))}
        </span>
      </div>

      {/* --- what this is, in plain words -------------------------------- */}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Every bull&apos;s round-to-round change has the whole lineup&apos;s move for that round taken off it first —
        so the April base change, which drops everyone at once, is removed and cannot make two bulls look alike just
        for having lived through the same rollbacks. What is left is each bull&apos;s <strong>own</strong> movement.
        Careers are lined up by position — his 1st round against the other bull&apos;s 1st round — so a bull from 2015
        can match a bull from 2024.{" "}
        {data.mode === "shape"
          ? "Shape mode normalises each bull's window before comparing, so it finds the same rhythm regardless of how big the moves were."
          : "Magnitude mode compares the moves as they stand, so it finds bulls who moved by the same amounts as well as in the same pattern."}
        {combined && " Each trait is normalised before the nine are combined, so LPI (residuals in the hundreds) cannot drown out Conformation (single digits)."}
      </p>
      <p className="mt-1 text-[11px] font-medium leading-relaxed text-amber-700">
        This describes the past only. Two bulls having moved alike is <strong>not</strong> evidence that they will move
        alike next round — which way a proof goes next is not forecastable, which is why this report&apos;s projected
        value is simply the current one.
      </p>

      {/* --- results ------------------------------------------------------ */}
      {data.status !== "ok" || data.matches.length === 0 ? (
        <p className="mt-3 rounded bg-slate-50 px-2 py-2 text-[11px] text-slate-600">
          {data.status === "insufficient-history" &&
            `Too little history to match on ${data.traitLabel}: a match needs at least ${data.minOverlap} comparable rounds, and this bull does not have them yet.`}
          {data.status === "no-own-movement" &&
            `Nothing of his own to match on ${data.traitLabel}: every round he simply moved with the lineup, so once the round's cohort movement is removed there is no shape left.`}
          {data.status === "unknown" && "This bull is not in the reported lineup."}
          {data.status === "ok" &&
            `No bull in ${data.cohort === 0 ? "the lineup" : `the other ${data.cohort} bulls`} shares at least ${data.minOverlap} comparable rounds with him on ${data.traitLabel}, of which ${data.minInformative} where both of them actually moved.`}
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 pr-3 font-medium">#</th>
                  <th className="py-1 pr-3 font-medium">Bull</th>
                  <th className="py-1 pr-3 font-medium">NAAB</th>
                  <th className="py-1 pr-3 text-right font-medium" title="Root-mean-square distance between the two residual series — lower is more alike. Note the list is NOT ordered by it; see Evidence.">
                    Distance
                  </th>
                  <th
                    className="py-1 pr-3 text-right font-medium"
                    title={data.mode === "shape"
                      ? combined
                        ? "The overlap-weighted mean of the per-trait correlations, over the traits that matched — not a single correlation. 1.00 is the same rhythm, 0.00 is no relationship, negative is the mirror image."
                        : "Correlation between the two residual series. 1.00 is the same rhythm, 0.00 is no relationship, negative is the mirror image."
                      : "A 0-100 reading of the distance."}
                  >
                    {data.mode === "shape" ? "Correlation" : "Closeness"}
                  </th>
                  <th
                    className="py-1 pr-3 text-right font-medium"
                    title="How strong the match is once the number of shared moving rounds is taken into account. The list is ordered by THIS, not by raw closeness, so a modest match across a long career outranks a flattering one across only a handful of rounds."
                  >
                    Evidence
                  </th>
                  <th className="py-1 pr-3 text-right font-medium" title="Career steps where both bulls had a comparable round — not multiplied by the number of traits. Read the correlation against this.">
                    Rounds overlapped
                  </th>
                  <th className="py-1 pr-3 text-right font-medium" title="…of those, the rounds where BOTH bulls actually moved on their own. A window of mostly flat rounds agrees about nothing.">
                    of which moving
                  </th>
                  {combined && <th className="py-1 pr-3 text-right font-medium">Traits</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.matches.map((m, i) => (
                  <tr key={m.id}>
                    <td className="py-1 pr-3">
                      <span
                        className="inline-block h-2 w-4 rounded-sm align-middle"
                        style={{ background: OVERLAY_COLORS[i % OVERLAY_COLORS.length] }}
                      />
                    </td>
                    <td className="py-1 pr-3">
                      <Link href={`/animals/${m.id}`} className="link font-medium">{m.name}</Link>
                      {m.breed && <span className="ml-1 text-slate-400">· {m.breed}</span>}
                    </td>
                    <td className="py-1 pr-3 font-mono text-slate-500">{m.naab ?? "—"}</td>
                    <td className="py-1 pr-3 text-right tabular-nums text-slate-700">{m.distance}</td>
                    <td className="py-1 pr-3 text-right tabular-nums font-semibold text-slate-800">
                      {data.mode === "shape" ? m.similarity.toFixed(2) : Math.round(m.similarity * 100)}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums text-slate-700">{m.score.toFixed(2)}</td>
                    <td
                      className={`py-1 pr-3 text-right tabular-nums ${m.rounds < THIN_OVERLAP ? "font-semibold text-amber-600" : "text-slate-500"}`}
                      title={m.rounds < THIN_OVERLAP ? "Thin: over a window this short, an unrelated bull scores well by luck alone" : undefined}
                    >
                      {m.rounds}{m.rounds < THIN_OVERLAP && " ⚠"}
                    </td>
                    <td
                      className={`py-1 pr-3 text-right tabular-nums ${m.informativeRounds < THIN_OVERLAP ? "font-semibold text-amber-600" : "text-slate-500"}`}
                      title={m.informativeRounds < THIN_OVERLAP ? "Thin: few of the shared rounds are rounds where either bull did anything" : undefined}
                    >
                      {m.informativeRounds}{m.informativeRounds < THIN_OVERLAP && " ⚠"}
                    </td>
                    {combined && (
                      <td className="py-1 pr-3 text-right tabular-nums text-slate-500">
                        {m.traitsMatched}/{data.codes.length}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.subject.length > 0 && (
            <div className="mt-3">
              <TraitTrendChart
                series={data.subject}
                overlays={data.matches.map((m) => ({ id: m.id, label: m.name, series: m.series }))}
                xLabel="x = career position (his 1st round, 2nd round, …). y = cumulative own movement, cohort removed — where his proof would have travelled if the rest of the lineup had stood still."
                zeroLine
                showSummary={false}
              />
            </div>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            <strong>Read the score against the overlap.</strong> A short window makes a low distance cheap: over{" "}
            {data.minOverlap} shared rounds an unrelated bull reaches a correlation of about 0.58 by luck alone, over 40
            rounds only about 0.16. So the list is <strong>not</strong> ordered by distance — it is ordered by evidence,
            the correlation divided by what it would be worth by luck over that many rounds. A modest score across a
            long career therefore outranks a flattering one across {data.minOverlap} rounds, and overlaps below{" "}
            {THIN_OVERLAP} are flagged amber on top of that. A round only counts as evidence when{" "}
            <strong>both</strong> bulls moved on their own that round: a trait needs {data.minInformative} such rounds
            before it is compared at all, so two bulls cannot be matched on one coincidence in an otherwise flat window.
            {data.mode === "shape" && " A distance past 1.41 is a negative correlation — that bull moved OPPOSITE to him, not with him."}
          </p>
          <p className="mt-2 text-[10px] text-slate-400">
            Matched against {data.compared} of {data.cohort} other bulls in this lineup
            {data.skipped > 0 && `; ${data.skipped} were left out for sharing fewer than ${data.minOverlap} comparable rounds, for having fewer than ${data.minInformative} rounds where both bulls moved, or for never having moved on their own`}
            {data.roundsWithoutCohortTerm > 0 && `; ${data.roundsWithoutCohortTerm} trait-rounds had too few bulls on file to measure the lineup's move, so those steps were dropped rather than compared raw`}
            {data.stepsAcrossMissedRounds > 0 && `; ${data.stepsAcrossMissedRounds} steps crossed a round the bull has no proof for and were corrected against every round they crossed, not just the one they landed on`}
            {data.stepsDropped > 0 && `; ${data.stepsDropped} steps were dropped because a round they crossed could not be measured`}
            .
          </p>
        </>
      )}
    </div>
  );
}
