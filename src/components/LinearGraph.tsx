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

  /**
   * Which end of the track is the better animal, where the app has a reasoned
   * answer. OPTIONAL, and omitting it keeps the original behaviour exactly:
   * positive shaded favourable, negative unfavourable.
   *
   * It exists because that original behaviour is a lie on a trait whose good end
   * is the low one. A bull two points SHORT is a good bull on a scale that runs
   * Short-to-Tall, and drawing his bar in the "bad" colour tells the reader the
   * opposite of the truth — the picture wins over any caption underneath it.
   * "intermediate" means neither end is the target, so neither end is shaded.
   */
  favourable?: "left" | "right" | "intermediate";
}

export interface LinearGroup {
  group: string;
  traits: LinearTraitDatum[];
}

function pct(value: number, min: number, max: number): number {
  const p = ((value - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, p));
}

/** Bar colour. Green means "the good end" — never merely "the positive end". */
function barTone(t: LinearTraitDatum): string {
  if (t.favourable === "intermediate") return "bg-slate-400";
  const good = t.favourable === "left" ? t.value <= 0 : t.value >= 0;
  return good ? "bg-brand-500" : "bg-amber-500";
}

export function LinearGraph({ groups }: { groups: LinearGroup[] }) {
  if (groups.length === 0) return null;
  const all = groups.flatMap((g) => g.traits);
  const rated = all.some((t) => t.favourable === "left" || t.favourable === "right");
  const anyIntermediate = all.some((t) => t.favourable === "intermediate");
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
              const opt = t.favourable === "intermediate";
              // Which descriptor names the better animal, so the reader can see the
              // direction on the chart itself rather than having to remember it.
              const goodEnd = t.favourable === "left" || t.favourable === "right" ? t.favourable : null;
              return (
                <div key={t.name} className="grid grid-cols-12 items-center gap-2 text-xs">
                  <div className="col-span-3 flex min-w-0 items-center gap-1">
                    <span className="truncate font-medium text-slate-700" title={t.name}>{t.name}</span>
                    {opt && (
                      <span
                        className="shrink-0 rounded bg-slate-200 px-1 text-[9px] font-bold uppercase leading-4 tracking-wide text-slate-600"
                        title="Intermediate optimum — the middle of the scale is the target, so neither end of this bar is the better bull."
                      >
                        opt
                      </span>
                    )}
                  </div>
                  <div className={`col-span-2 truncate text-right text-[10px] ${goodEnd === "left" ? "font-semibold text-brand-600" : "text-slate-400"}`}>
                    {t.left}
                  </div>
                  <div className="col-span-4">
                    <div className="relative h-4 rounded bg-slate-100">
                      {/* centre line */}
                      <div className="absolute top-0 bottom-0 w-px bg-slate-400" style={{ left: `${center}%` }} />
                      {/* value bar */}
                      <div
                        className={`absolute top-0.5 bottom-0.5 rounded ${barTone(t)}`}
                        style={{ left: `${barLeft}%`, width: `${Math.max(barWidth, 0.6)}%` }}
                      />
                      {/* value marker */}
                      <div className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-slate-800" style={{ left: `${p}%` }} />
                    </div>
                  </div>
                  <div className={`col-span-2 truncate text-[10px] ${goodEnd === "right" ? "font-semibold text-brand-600" : "text-slate-400"}`}>
                    {t.right}
                  </div>
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded bg-brand-500" /> {rated ? "toward the favourable end" : "positive deviation"}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded bg-amber-500" /> {rated ? "away from it" : "negative deviation"}
        </span>
        {anyIntermediate && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded bg-slate-400" /> intermediate optimum (<strong className="font-bold text-slate-500">opt</strong>) — middle is the target, neither end is better
          </span>
        )}
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-px bg-slate-400" /> breed average (0)</span>
        {rated && <span>Bold descriptor marks the end this stud selects toward.</span>}
      </div>
    </div>
  );
}
