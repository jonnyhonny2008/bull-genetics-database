"use client";

import { useState } from "react";

export interface TrendSeries {
  code: string;
  label: string;
  points: { date: string; label: string; value: number }[];
}

// Dependency-free SVG line chart of one trait across a bull's proof rounds, with
// a trait selector. Colours follow the theme (currentColor = text-brand-600).
export function TraitTrendChart({ series }: { series: TrendSeries[] }) {
  const [code, setCode] = useState(series[0]?.code ?? "");
  const s = series.find((x) => x.code === code) ?? series[0];
  if (!s || s.points.length < 2) return null;

  const W = 720, H = 240, padL = 48, padR = 18, padT = 18, padB = 34;
  const n = s.points.length;
  const ys = s.points.map((p) => p.value);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const padY = (maxY - minY) * 0.08;
  minY -= padY; maxY += padY;
  const spanY = maxY - minY || 1;
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - minY) / spanY) * (H - padT - padB);
  const path = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(n - 1).toFixed(1)},${(H - padB).toFixed(1)} L${x(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const first = s.points[0], last = s.points[n - 1];
  const delta = Math.round((last.value - first.value) * 100) / 100;
  const up = delta > 0, flat = delta === 0;
  const TICKS = 4;
  const xLabelIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select value={code} onChange={(e) => setCode(e.target.value)} className="input max-w-[220px]">
          {series.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
        </select>
        <span className="text-sm text-slate-600">
          <span className="font-semibold">{first.value}</span> → <span className="font-semibold">{last.value}</span>{" "}
          <span className={flat ? "text-slate-400" : up ? "text-emerald-600" : "text-red-600"}>({up ? "+" : ""}{delta})</span>
          <span className="ml-1 text-xs text-slate-400">across {n} rounds</span>
        </span>
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
          <path d={area} fill="currentColor" opacity={0.08} />
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {s.points.map((p, i) => (
            <circle key={i} cx={x(i)} cy={y(p.value)} r={3.5} fill="#fff" stroke="currentColor" strokeWidth={2}>
              <title>{p.label}: {p.value}</title>
            </circle>
          ))}
          {xLabelIdx.map((i) => (
            <text key={i} x={x(i)} y={H - padB + 16} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-slate-400" fontSize={10}>
              {s.points[i].label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
