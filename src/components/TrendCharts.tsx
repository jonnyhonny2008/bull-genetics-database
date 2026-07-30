"use client";

// Lightweight, dependency-free SVG charts for the Proof Trends section.
// Interactive + modular: hover a proof round for a guide line and a tooltip of
// every series' value there, and click a legend entry to show/hide that series.
// No external chart lib — inline SVG so it works anywhere, light or dark.

import { useState } from "react";

export interface LineSeries {
  label: string;
  color: string;
  /** `note` is shown per-point in the tooltip (e.g. the real proof month). */
  points: { x: string; y: number | null; note?: string }[];
  /** Render as a dashed reference line (used for the lineup average). */
  dashed?: boolean;
}

export function LineChart({
  series,
  height = 240,
  yLabel,
  valueSuffix = "",
  xUnit = "",
}: {
  series: LineSeries[];
  height?: number;
  yLabel?: string;
  valueSuffix?: string;
  /** Prefix for the tooltip header, e.g. "Rollback " → "Rollback 5". */
  xUnit?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  const xs = series[0]?.points.map((p) => p.x) ?? [];
  const visible = series.filter((s) => !hidden[s.label]);
  const allY = visible.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y != null));
  if (xs.length === 0 || series.length === 0) return <div className="text-sm text-slate-500">No data to chart.</div>;

  // Y domain from visible series (fall back to all series so an empty toggle
  // state doesn't collapse the axis).
  const domainY = allY.length ? allY : series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y != null));
  let min = domainY.length ? Math.min(...domainY) : 0;
  let max = domainY.length ? Math.max(...domainY) : 1;
  if (min === max) { min -= 1; max += 1; }
  const padY = (max - min) * 0.12; min -= padY; max += padY;

  // Generous margins so axis text always has room (left for y-ticks + label,
  // bottom for x-labels, top for the y-axis caption).
  const W = 760, H = height, ml = 60, mr = 22, mt = 22, mb = 48;
  const iw = W - ml - mr, ih = H - mt - mb;
  const xAt = (i: number) => ml + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const yAt = (v: number) => mt + ih - ((v - min) / (max - min)) * ih;
  const ticks = 4;

  // Thin x-labels to ~9 evenly spaced (plus first & last) so months never collide.
  const step = Math.max(1, Math.ceil(xs.length / 9));
  const showX = (i: number) => i === 0 || i === xs.length - 1 || i % step === 0;
  const shortX = (x: string) => x.replace(/ 20/, " '").replace(/^(\d{4})-(\d{2})$/, "$2/$1");

  const fmt = (v: number) => `${Math.round(v * 10) / 10}${valueSuffix}`;

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        style={{ minWidth: 520 }}
        role="img"
        aria-label={yLabel ? `${yLabel} over proof rounds` : "trend chart"}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width === 0) return;
          const vbX = ((e.clientX - r.left) / r.width) * W;
          let best = 0, bestD = Infinity;
          for (let i = 0; i < xs.length; i++) { const d = Math.abs(xAt(i) - vbX); if (d < bestD) { bestD = d; best = i; } }
          setActive(best);
        }}
        onMouseLeave={() => setActive(null)}
      >
        {/* horizontal gridlines + y tick labels */}
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const v = min + ((max - min) * i) / ticks; const y = yAt(v);
          return (
            <g key={i}>
              <line x1={ml} y1={y} x2={W - mr} y2={y} stroke="currentColor" strokeOpacity="0.12" />
              <text x={ml - 8} y={y + 3} textAnchor="end" fontSize="11" fill="currentColor" fillOpacity="0.55">{Math.round(v)}</text>
            </g>
          );
        })}

        {/* x labels (thinned) */}
        {xs.map((x, i) => (showX(i) ? (
          <text key={i} x={xAt(i)} y={H - 16} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.6">{shortX(x)}</text>
        ) : null))}

        {/* active guide line */}
        {active != null && <line x1={xAt(active)} y1={mt} x2={xAt(active)} y2={mt + ih} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 3" />}

        {/* series */}
        {visible.map((s) => {
          const pts = s.points.map((p, i) => (p.y == null ? null : `${xAt(i)},${yAt(p.y)}`)).filter(Boolean).join(" ");
          return (
            <g key={s.label}>
              <polyline
                points={pts}
                fill="none"
                stroke={s.color}
                strokeWidth={s.dashed ? 2 : 2.5}
                strokeDasharray={s.dashed ? "6 5" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={s.dashed ? 0.85 : 1}
              />
              {!s.dashed && s.points.map((p, i) => (p.y == null ? null : (
                <circle key={i} cx={xAt(i)} cy={yAt(p.y)} r={active === i ? 5 : 3} fill={s.color} />
              )))}
              {s.dashed && active != null && s.points[active]?.y != null && (
                <circle cx={xAt(active)} cy={yAt(s.points[active]!.y as number)} r={4} fill={s.color} />
              )}
            </g>
          );
        })}

        {/* y-axis caption */}
        {yLabel && <text x={ml} y={12} fontSize="11" fill="currentColor" fillOpacity="0.6">{yLabel}</text>}

        {/* tooltip */}
        {active != null && (() => {
          const rows = visible
            .map((s) => ({ label: s.label, color: s.color, y: s.points[active]?.y ?? null, note: s.points[active]?.note }))
            .filter((r) => r.y != null) as { label: string; color: string; y: number; note?: string }[];
          if (rows.length === 0) return null;
          const gx = xAt(active);
          const hasNotes = rows.some((r) => r.note);
          const lineH = hasNotes ? 26 : 16;
          const boxW = hasNotes ? 210 : 168, boxH = 24 + rows.length * lineH;
          const flip = gx > W - boxW - 12;
          const bx = flip ? gx - boxW - 10 : gx + 10;
          const by = Math.min(mt, H - mb - boxH);
          return (
            <g pointerEvents="none">
              <rect x={bx} y={by} width={boxW} height={boxH} rx="6" fill="white" stroke="currentColor" strokeOpacity="0.15" />
              <text x={bx + 10} y={by + 15} fontSize="10.5" fontWeight="600" fill="#334155">{xUnit}{xs[active]}</text>
              {rows.map((r, i) => { const ry = by + 24 + i * lineH; return (
                <g key={r.label}>
                  <rect x={bx + 10} y={ry + 2} width="9" height="9" rx="2" fill={r.color} />
                  <text x={bx + 23} y={ry + 10} fontSize="10.5" fill="#475569">{r.label.length > 20 ? r.label.slice(0, 19) + "…" : r.label}</text>
                  <text x={bx + boxW - 10} y={ry + 10} textAnchor="end" fontSize="10.5" fontWeight="600" fill="#1e293b">{fmt(r.y)}</text>
                  {r.note && <text x={bx + 23} y={ry + 21} fontSize="9" fill="#94a3b8">{r.note}</text>}
                </g>
              ); })}
            </g>
          );
        })()}
      </svg>

      {/* legend — click to toggle a series */}
      {series.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
          {series.map((s) => {
            const off = hidden[s.label];
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => setHidden((h) => ({ ...h, [s.label]: !h[s.label] }))}
                className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 transition ${off ? "opacity-40" : "hover:bg-slate-100"}`}
                title={off ? "Show series" : "Hide series"}
              >
                <span className="inline-block h-2 w-4 rounded" style={{ background: s.color, ...(s.dashed ? { backgroundImage: "repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)" } : {}) }} />
                <span className={off ? "line-through" : ""}>{s.label}</span>
              </button>
            );
          })}
          <span className="text-slate-400">· hover the chart for values · click a label to toggle</span>
        </div>
      )}
    </div>
  );
}

// Grouped horizontal bars comparing a bull's value against the lineup average.
export function CompareBars({ rows, aLabel, bLabel }: { rows: { label: string; a: number | null; b: number | null }[]; aLabel: string; bLabel: string }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-xs">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded bg-brand-500" />{aLabel}</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded bg-slate-400" />{bLabel}</span>
      </div>
      {rows.map((r) => {
        const max = Math.max(Math.abs(r.a ?? 0), Math.abs(r.b ?? 0), 1);
        const w = (v: number | null) => `${Math.min(100, (Math.abs(v ?? 0) / max) * 100)}%`;
        return (
          <div key={r.label}>
            <div className="mb-0.5 flex justify-between text-xs"><span className="font-medium text-slate-600">{r.label}</span>
              <span className="tabular-nums text-slate-500">{r.a ?? "—"} <span className="text-slate-300">vs</span> {r.b ?? "—"}</span></div>
            <div className="space-y-0.5">
              <div className="h-2.5 rounded bg-brand-500" style={{ width: w(r.a) }} />
              <div className="h-2.5 rounded bg-slate-400" style={{ width: w(r.b) }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
