// Lightweight, dependency-free SVG charts for the Proof Trends section.
// (No external chart lib — inline SVG so it works anywhere, light/dark.)

export interface LineSeries { label: string; color: string; points: { x: string; y: number | null }[] }

export function LineChart({ series, height = 220, yLabel }: { series: LineSeries[]; height?: number; yLabel?: string }) {
  const xs = series[0]?.points.map((p) => p.x) ?? [];
  const allY = series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y != null));
  if (allY.length === 0 || xs.length === 0) return <div className="text-sm text-slate-500">No data to chart.</div>;
  let min = Math.min(...allY), max = Math.max(...allY);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const W = 640, H = height, ml = 48, mr = 16, mt = 12, mb = 34;
  const iw = W - ml - mr, ih = H - mt - mb;
  const xAt = (i: number) => ml + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const yAt = (v: number) => mt + ih - ((v - min) / (max - min)) * ih;
  const ticks = 4;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 480 }} role="img">
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const v = min + ((max - min) * i) / ticks; const y = yAt(v);
          return (<g key={i}>
            <line x1={ml} y1={y} x2={W - mr} y2={y} stroke="currentColor" strokeOpacity="0.12" />
            <text x={ml - 6} y={y + 3} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.55">{Math.round(v)}</text>
          </g>);
        })}
        {xs.map((x, i) => (<text key={i} x={xAt(i)} y={H - 12} textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.55">{x.replace(/ 20/, " '")}</text>))}
        {series.map((s) => {
          const pts = s.points.map((p, i) => (p.y == null ? null : `${xAt(i)},${yAt(p.y)}`)).filter(Boolean).join(" ");
          return (<g key={s.label}>
            <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            {s.points.map((p, i) => p.y == null ? null : <circle key={i} cx={xAt(i)} cy={yAt(p.y)} r="3.5" fill={s.color} />)}
          </g>);
        })}
        {yLabel && <text x={12} y={mt + 4} fontSize="10" fill="currentColor" fillOpacity="0.55">{yLabel}</text>}
      </svg>
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-3 text-xs">
          {series.map((s) => <span key={s.label} className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded" style={{ background: s.color }} />{s.label}</span>)}
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
