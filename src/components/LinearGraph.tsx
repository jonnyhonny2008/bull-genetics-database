// Classic "linear" evaluation chart, like the one printed on a bull proof.
// Each type trait is a horizontal track: breed average is the centre line, and
// the animal's evaluation extends left or right toward the biological descriptor.

export interface LinearTraitDatum {
  name: string;
  value: number; // signed deviation
  min: number; // e.g. -15
  max: number; // e.g. +15
  left: string; // descriptor at the low end
  right: string; // descriptor at the high end
  descriptor?: string | null; // ALPHA letter from the proof
}

export interface LinearGroup {
  group: string;
  traits: LinearTraitDatum[];
}

function pct(value: number, min: number, max: number): number {
  const p = ((value - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, p));
}

export function LinearGraph({ groups }: { groups: LinearGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.group}>
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{g.group}</div>
          <div className="space-y-1.5">
            {g.traits.map((t) => {
              const p = pct(t.value, t.min, t.max);
              const center = pct(0, t.min, t.max);
              const barLeft = Math.min(center, p);
              const barWidth = Math.abs(p - center);
              const positive = t.value >= 0;
              return (
                <div key={t.name} className="grid grid-cols-12 items-center gap-2 text-xs">
                  <div className="col-span-3 truncate font-medium text-slate-700" title={t.name}>{t.name}</div>
                  <div className="col-span-2 truncate text-right text-[10px] text-slate-400">{t.left}</div>
                  <div className="col-span-4">
                    <div className="relative h-4 rounded bg-slate-100">
                      {/* centre line */}
                      <div className="absolute top-0 bottom-0 w-px bg-slate-400" style={{ left: `${center}%` }} />
                      {/* value bar */}
                      <div
                        className={`absolute top-0.5 bottom-0.5 rounded ${positive ? "bg-brand-500" : "bg-amber-500"}`}
                        style={{ left: `${barLeft}%`, width: `${Math.max(barWidth, 0.6)}%` }}
                      />
                      {/* value marker */}
                      <div className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-slate-800" style={{ left: `${p}%` }} />
                    </div>
                  </div>
                  <div className="col-span-2 truncate text-[10px] text-slate-400">{t.right}</div>
                  <div className="col-span-1 text-right font-mono font-semibold text-slate-700">
                    {t.value > 0 ? "+" : ""}{t.value}
                    {t.descriptor ? <span className="ml-0.5 text-[10px] text-slate-400">{t.descriptor}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-4 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded bg-brand-500" /> positive deviation</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded bg-amber-500" /> negative deviation</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-px bg-slate-400" /> breed average (0)</span>
      </div>
    </div>
  );
}
