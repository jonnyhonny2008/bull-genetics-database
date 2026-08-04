"use client";

// Projection table. Each row is a bull's projected next proof; expanding a row
// reveals the FULL projected profile — index traits and linear/type traits —
// with the uncertainty band on every number.

import Link from "next/link";
import { Fragment, useState } from "react";
import { HScroll } from "./HScroll";
import type { ForecastRow, TraitForecast, Confidence, ExposureBand } from "@/lib/proof-forecast";

const CONF_TONE: Record<Confidence, string> = {
  high: "bg-brand-100 text-brand-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-600",
};

/** Exposed reads as a warning, steady as reassurance — neither is good or bad. */
const EXPOSURE_TONE: Record<ExposureBand, string> = {
  exposed: "bg-amber-100 text-amber-800",
  typical: "bg-slate-100 text-slate-600",
  steady: "bg-emerald-100 text-emerald-800",
};

function deltaClass(d: number | null): string {
  if (d == null || d === 0) return "text-slate-400";
  return d > 0 ? "text-emerald-700" : "text-red-600";
}
const sign = (d: number | null) => (d == null ? "—" : `${d > 0 ? "+" : ""}${d}`);

/** Colour the confidence figure so a weak projection is visible at a glance. */
export function confidenceClass(c: number | null): string {
  if (c == null) return "text-slate-400";
  return c >= 0.7 ? "text-emerald-700" : c >= 0.45 ? "text-amber-600" : "text-red-600";
}
const pct = (c: number | null) => (c == null ? "—" : `${Math.round(c * 100)}%`);

/** One trait line: the projected value for the next round, and the confidence in it. */
function TraitLine({ t }: { t: TraitForecast }) {
  return (
    <div className="flex items-baseline justify-between gap-3 whitespace-nowrap py-0.5">
      <span className="text-xs text-slate-600">{t.name}</span>
      <span className="flex items-baseline gap-2 tabular-nums">
        <span className="text-[11px] text-slate-400">{t.current ?? "—"} →</span>
        <span className="text-xs font-semibold text-slate-800">{t.predicted ?? "—"}</span>
        {t.confidence != null
          ? <span className={`text-[11px] font-semibold ${confidenceClass(t.confidence)}`}>{pct(t.confidence)}</span>
          : <span className={`text-xs font-semibold ${deltaClass(t.delta)}`}>{sign(t.delta)}</span>}
      </span>
    </div>
  );
}

function BullDetail({ row }: { row: ForecastRow }) {
  const f = row.forecast;
  const key = f.allForecasts.filter((t) => t.key);
  const others = f.allForecasts.filter((t) => !t.key);
  // Group the non-key traits by category so the linear/type profile reads as a
  // profile rather than one long alphabetical list.
  const groups = new Map<string, TraitForecast[]>();
  for (const t of others) {
    const g = t.category ?? "Other";
    const arr = groups.get(g);
    if (arr) arr.push(t); else groups.set(g, [t]);
  }

  return (
    <div className="space-y-4 border-t border-slate-200 bg-slate-50/60 px-3 py-3">
      {f.drivers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {f.drivers.map((d) => (
            <span key={d} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200">{d}</span>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Key traits</div>
        <HScroll>
          <div className="grid min-w-[520px] grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {key.map((t) => <TraitLine key={t.code} t={t} />)}
          </div>
        </HScroll>
      </div>

      {[...groups.entries()].map(([g, ts]) => (
        <div key={g}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{g}</div>
          <HScroll>
            <div className="grid min-w-[520px] grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
              {ts.map((t) => <TraitLine key={t.code} t={t} />)}
            </div>
          </HScroll>
        </div>
      ))}

      <p className="text-[11px] text-slate-400">
        Each figure is the current value, the <strong>projected value</strong> for the next round, and the
        <strong> confidence</strong> in that projection — the share of bulls at the same career stage whose value
        landed close to where it started. These are modelled, not a published proof.
      </p>
    </div>
  );
}

export function ProofForecastTable({
  rows,
  keyTraits,
  sort,
  dir,
  params,
  basePath,
}: {
  rows: ForecastRow[];
  keyTraits: { code: string; label: string }[];
  sort: string;
  dir: "asc" | "desc";
  params: Record<string, string>;
  basePath: string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const sortHref = (code: string) => {
    const p = new URLSearchParams(params);
    p.set("sort", code);
    p.set("dir", sort === code && dir === "desc" ? "asc" : "desc");
    return `${basePath}?${p.toString()}`;
  };
  const arrow = (code: string) => (sort === code ? (dir === "desc" ? " ↓" : " ↑") : "");

  return (
    <div className="card overflow-hidden">
      <HScroll stickyTop>
        <table className="min-w-[880px] w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="th w-8" />
              <th className="th">
                <Link href={sortHref("name")} prefetch={false} className="hover:text-brand-700">Bull{arrow("name")}</Link>
              </th>
              <th className="th">
                <Link href={sortHref("exposure")} prefetch={false} className="hover:text-brand-700" title="Average confidence in this bull's projected values across the nine key traits">
                  Confidence{arrow("exposure")}
                </Link>
              </th>
              <th className="th">
                <Link href={sortHref("confidence")} prefetch={false} className="hover:text-brand-700" title="How much history backs the forecast: rounds on file and reliability">
                  Evidence{arrow("confidence")}
                </Link>
              </th>
              {keyTraits.map((t) => (
                <th key={t.code} className="th text-right" title={`Projected ${t.label} for the next round, and the confidence in that value`}>
                  <Link href={sortHref(t.code.toLowerCase())} prefetch={false} className="hover:text-brand-700">{t.label}{arrow(t.code.toLowerCase())}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const isOpen = !!open[r.id];
              const byCode = new Map(r.forecast.keyForecasts.map((f) => [f.code, f]));
              return (
                <Fragment key={r.id}>
                  <tr>
                    <td className="td w-8">
                      <button
                        type="button"
                        onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Hide full profile" : "Show full projected profile"}
                        className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        {isOpen ? "−" : "+"}
                      </button>
                    </td>
                    <td className="td">
                      <Link href={`/animals/${r.id}`} className="link font-medium">{r.name}</Link>
                      <div className="text-[11px] text-slate-400">
                        {r.naab ?? r.reg ?? "—"} · {r.forecast.roundsOnFile} rounds
                      </div>
                    </td>
                    <td className="td">
                      {r.forecast.confidencePct != null ? (
                        <div className={`font-semibold tabular-nums ${confidenceClass(r.forecast.confidencePct)}`}>
                          {pct(r.forecast.confidencePct)}
                        </div>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="td">
                      <span className={`badge ${CONF_TONE[r.forecast.confidence]}`}>{r.forecast.confidence}</span>
                    </td>
                    {keyTraits.map((t) => {
                      const f = byCode.get(t.code);
                      return (
                        <td key={t.code} className="td text-right">
                          {!f ? <span className="text-slate-300">—</span> : (
                            <>
                              {/* Projected value for the next round, then the confidence in it. */}
                              <div className="font-semibold tabular-nums text-slate-800">{f.predicted ?? "—"}</div>
                              {f.confidence != null
                                ? <div className={`text-[11px] font-semibold tabular-nums ${confidenceClass(f.confidence)}`}>{pct(f.confidence)}</div>
                                : <div className={`text-[11px] tabular-nums ${deltaClass(f.delta)}`}>{sign(f.delta)}</div>}
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={4 + keyTraits.length} className="p-0">
                        <BullDetail row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </HScroll>
    </div>
  );
}
