"use client";

import { useState } from "react";

export interface TrendPoint {
  date: string;
  label: string;
  value: number;
  /** Extra context for the hover title (e.g. which proof round a step landed on). */
  hint?: string;
}

export interface TrendSeries {
  code: string;
  label: string;
  points: TrendPoint[];
}

/** A comparison curve drawn against the same axes as the main series. */
export interface TrendOverlay {
  id: string;
  label: string;
  series: TrendSeries[];
}

/**
 * Palette for overlaid curves. Fixed order so the nth match keeps its colour
 * between the legend, the table and the line.
 */
export const OVERLAY_COLORS = [
  "#0ea5e9", "#f97316", "#8b5cf6", "#14b8a6",
  "#e11d48", "#65a30d", "#a855f7", "#0891b2",
];

// Dependency-free SVG line chart of one trait across a bull's proof rounds, with
// a trait selector. Colours follow the theme (currentColor = text-brand-600).
//
// `overlays` is optional and additive: without it this renders exactly what it
// always did (one bull, one trait). With it, the same axes carry comparison
// curves — used by "Sires that move like him", which needs the subject's curve
// with each match drawn over it rather than a second chart implementation.
// Every series is plotted by INDEX, so when the caller has built career-aligned
// points (his 1st round against the other's 1st round) the x axis is career
// position rather than calendar date.
export function TraitTrendChart({
  series,
  overlays = [],
  xLabel,
  zeroLine = false,
  showSummary = true,
}: {
  series: TrendSeries[];
  overlays?: TrendOverlay[];
  /** Caption under the x axis, when the axis is not simply "proof rounds". */
  xLabel?: string;
  /** Draw a reference line at y = 0 (meaningful when values are differences). */
  zeroLine?: boolean;
  /** The "first → last" line above the chart. Off when it would be misleading. */
  showSummary?: boolean;
}) {
  const [code, setCode] = useState(series[0]?.code ?? "");
  const s = series.find((x) => x.code === code) ?? series[0];
  if (!s || s.points.length < 2) return null;

  const ov = overlays
    .map((o, i) => ({ id: o.id, label: o.label, color: OVERLAY_COLORS[i % OVERLAY_COLORS.length], pts: o.series.find((x) => x.code === s.code)?.points ?? [] }))
    .filter((o) => o.pts.length >= 2);

  const W = 720, H = 240, padL = 48, padR = 18, padT = 18, padB = 34;
  const n = Math.max(s.points.length, ...ov.map((o) => o.pts.length));
  const ys = [...s.points.map((p) => p.value), ...ov.flatMap((o) => o.pts.map((p) => p.value))];
  if (zeroLine) ys.push(0);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const padY = (maxY - minY) * 0.08;
  minY -= padY; maxY += padY;
  const spanY = maxY - minY || 1;
  const x = (i: number) => padL + (n > 1 ? i / (n - 1) : 0) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - minY) / spanY) * (H - padT - padB);
  const lineOf = (pts: { value: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const path = lineOf(s.points);
  const sn = s.points.length;
  const area = `${path} L${x(sn - 1).toFixed(1)},${(H - padB).toFixed(1)} L${x(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const first = s.points[0], last = s.points[sn - 1];
  const delta = Math.round((last.value - first.value) * 100) / 100;
  const up = delta > 0, flat = delta === 0;
  const TICKS = 4;
  const xLabelIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  const labelAt = (i: number) => s.points[i]?.label ?? `#${i + 1}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select value={code} onChange={(e) => setCode(e.target.value)} className="input max-w-[220px]">
          {series.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
        </select>
        {showSummary && (
          <span className="text-sm text-slate-600">
            <span className="font-semibold">{first.value}</span> → <span className="font-semibold">{last.value}</span>{" "}
            <span className={flat ? "text-slate-400" : up ? "text-emerald-600" : "text-red-600"}>({up ? "+" : ""}{delta})</span>
            <span className="ml-1 text-xs text-slate-400">across {sn} rounds</span>
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[240px] w-full min-w-[520px] text-brand-600" role="img" aria-label={`${s.label} across proof rounds`}>
          {Array.from({ length: TICKS + 1 }).map((_, i) => {
            const v = minY + (spanY * i) / TICKS;
            const yy = y(v);
            return (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="#e2e8f0" strokeWidth={1} />
                <text x={padL - 6} y={yy + 3} textAnchor="end" className="fill-slate-400" fontSize={10}>{Math.round(v * 10) / 10}</text>
              </g>
            );
          })}
          {zeroLine && minY < 0 && maxY > 0 && (
            <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
          )}
          {/* Overlays first, so the subject's own line always sits on top. */}
          {ov.map((o) => (
            <path key={o.id} d={lineOf(o.pts)} fill="none" stroke={o.color} strokeWidth={1.5} opacity={0.85} strokeLinejoin="round" strokeLinecap="round">
              <title>{o.label}</title>
            </path>
          ))}
          {ov.length === 0 && <path d={area} fill="currentColor" opacity={0.08} />}
          <path d={path} fill="none" stroke="currentColor" strokeWidth={ov.length ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
          {s.points.map((p, i) => (
            <circle key={i} cx={x(i)} cy={y(p.value)} r={3.5} fill="#fff" stroke="currentColor" strokeWidth={2}>
              <title>{p.label}: {p.value}{p.hint ? ` — ${p.hint}` : ""}</title>
            </circle>
          ))}
          {xLabelIdx.map((i) => (
            <text key={i} x={x(i)} y={H - padB + 16} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-slate-400" fontSize={10}>
              {labelAt(i)}
            </text>
          ))}
        </svg>
      </div>
      {(xLabel || ov.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          {xLabel && <span className="text-slate-400">{xLabel}</span>}
          {ov.length > 0 && (
            <>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-[2px] w-4 bg-brand-600" /> this bull
              </span>
              {ov.map((o) => (
                <span key={o.id} className="inline-flex items-center gap-1">
                  <span className="inline-block h-[2px] w-4" style={{ background: o.color }} /> {o.label}
                </span>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
