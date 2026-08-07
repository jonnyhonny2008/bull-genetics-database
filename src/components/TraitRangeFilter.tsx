"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  RANGE_PARAM, parseTraitRanges, serialiseTraitRanges, describeTraitRange, isImpossibleRange,
  type TraitRange,
} from "@/lib/trait-range";

// ---------------------------------------------------------------------------
// The trait range picker, shared by both animals lists.
//
// One component for Canada and America deliberately: the two sides disagree
// about units, scales and which traits exist, but they do NOT disagree about
// what "between 2 and 4" means. Everything country-specific arrives as data in
// `traits`, so there is one set of parsing and URL rules and no chance of the
// two lists drifting into different querystring dialects — which would matter,
// because SavedSearch replays a stored query string verbatim.
//
// The bounds are rendered OUTSIDE the panel as well as in it. A saved or emailed
// view opens with the panel shut, and a filtered list that does not say what it
// is filtered by is how somebody quotes the wrong bull's numbers.
// ---------------------------------------------------------------------------

export interface RangePickerTrait {
  code: string;
  name: string;
  group: string;
  unit: string | null;
  decimals: number;
  direction: "higher" | "lower" | "intermediate" | "unknown";
  /** Whether a positive value takes an explicit "+". Set by each side's
   *  catalogue — see the note on UsRangeTrait.signed. */
  signed: boolean;
  /** The trait's neutral point — 0, or 100 on the Canadian rating scales. */
  baseline?: number;
  note?: string;
}

const DIRECTION_HINT: Record<string, string> = {
  higher: "higher is better",
  lower: "lower is better",
  intermediate: "intermediate optimum — both extremes are faults",
  unknown: "",
};

/** A row being edited. Bounds are kept as strings so a half-typed "-" or "1." is
 *  not destroyed by a premature parse. */
interface DraftRow { code: string; min: string; max: string }

export function TraitRangeFilter({ basePath, traits }: { basePath: string; traits: RangePickerTrait[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);

  const allowed = useMemo(() => new Set(traits.map((t) => t.code)), [traits]);
  const byCode = useMemo(() => new Map(traits.map((t) => [t.code, t])), [traits]);
  const active = useMemo(
    () => parseTraitRanges(sp.get(RANGE_PARAM) ?? undefined, allowed),
    [sp, allowed],
  );

  const [rows, setRows] = useState<DraftRow[]>(() => toDrafts(active));

  const groups = useMemo(() => {
    const m = new Map<string, RangePickerTrait[]>();
    for (const t of traits) { const a = m.get(t.group) ?? []; a.push(t); m.set(t.group, a); }
    return [...m.entries()];
  }, [traits]);

  function openPanel() {
    // Re-seed from the URL each time, so cancelling really cancels.
    setRows(toDrafts(active));
    setOpen(true);
  }

  function push(value: string) {
    const params = new URLSearchParams(sp.toString());
    params.delete("page");
    if (value) params.set(RANGE_PARAM, value); else params.delete(RANGE_PARAM);
    const s = params.toString();
    router.push(s ? `${basePath}?${s}` : basePath);
  }

  function apply() {
    const parsed: TraitRange[] = [];
    for (const r of rows) {
      if (!r.code || !allowed.has(r.code)) continue;
      const min = toNum(r.min);
      const max = toNum(r.max);
      if (min == null && max == null) continue;
      if (parsed.some((p) => p.code === r.code)) continue;
      parsed.push({ code: r.code, min, max });
    }
    push(serialiseTraitRanges(parsed));
    setOpen(false);
  }

  function clearAll() {
    setRows([]);
    push("");
    setOpen(false);
  }

  /** Remove one bound straight from its chip, without opening the panel. */
  function removeOne(code: string) {
    push(serialiseTraitRanges(active.filter((r) => r.code !== code)));
  }

  const unused = traits.filter((t) => !rows.some((r) => r.code === t.code));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative inline-block">
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPanel())}
          className={`btn-sm ${active.length ? "btn-primary" : "btn-secondary"}`}
          title="Filter bulls by trait — at least, at most, or between"
        >
          ⇄ Trait ranges{active.length ? ` · ${active.length}` : ""} ▾
        </button>

        {open && (
          <div className="absolute z-30 mt-1 w-[430px] rounded-md border border-slate-200 bg-white p-3 shadow-lg">
            <div className="mb-2 text-xs text-slate-500">
              Set a <strong>minimum</strong>, a <strong>maximum</strong>, or both. Leave a box empty to
              leave that end open. Every trait you add must be satisfied at once.
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {rows.length === 0 && (
                <p className="rounded border border-dashed border-slate-200 px-2 py-3 text-center text-xs text-slate-400">
                  No trait ranges yet — add one below.
                </p>
              )}
              {rows.map((r, i) => {
                const t = byCode.get(r.code);
                const bad = toNum(r.min) != null && toNum(r.max) != null && (toNum(r.min) as number) > (toNum(r.max) as number);
                return (
                  <div key={i} className="rounded border border-slate-200 p-2">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={r.code}
                        onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}
                        className="input input-sm min-w-0 flex-1"
                      >
                        {groups.map(([g, list]) => (
                          <optgroup key={g} label={g}>
                            {list.map((t2) => (
                              // A trait already used elsewhere is disabled rather than hidden,
                              // so the list does not reshuffle under the cursor.
                              <option key={t2.code} value={t2.code} disabled={t2.code !== r.code && rows.some((x) => x.code === t2.code)}>
                                {t2.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <input
                        value={r.min} inputMode="decimal" placeholder="min"
                        onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))}
                        className="input input-sm w-[72px] text-right tabular-nums"
                      />
                      <span className="text-xs text-slate-400">to</span>
                      <input
                        value={r.max} inputMode="decimal" placeholder="max"
                        onChange={(e) => setRows((s) => s.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))}
                        className="input input-sm w-[72px] text-right tabular-nums"
                      />
                      <button
                        type="button" aria-label={`Remove ${t?.name ?? r.code}`}
                        onClick={() => setRows((s) => s.filter((_, j) => j !== i))}
                        className="px-1 text-slate-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-slate-400">
                      {t?.unit && <span>in {t.unit}</span>}
                      {t?.baseline ? <span>neutral is {t.baseline}</span> : null}
                      {t && DIRECTION_HINT[t.direction] && <span>{DIRECTION_HINT[t.direction]}</span>}
                      {t?.note && <span className="text-slate-500">{t.note}</span>}
                    </div>
                    {bad && (
                      <div className="mt-1 text-[10px] font-medium text-red-600">
                        Minimum is above the maximum — this will match nothing.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {unused.length > 0 && (
              <button
                type="button"
                onClick={() => setRows((s) => [...s, { code: unused[0].code, min: "", max: "" }])}
                className="mt-2 w-full rounded border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700"
              >
                + Add a trait
              </button>
            )}

            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
              <button type="button" onClick={clearAll} className="text-xs text-slate-500 hover:underline">Clear all</button>
              <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-secondary btn-sm">Cancel</button>
                <button type="button" onClick={apply} className="btn-primary btn-sm">Apply ranges</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {active.map((r) => {
        const t = byCode.get(r.code);
        if (!t) return null;
        const impossible = isImpossibleRange(r);
        return (
          <span
            key={r.code}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
              impossible ? "border-red-300 bg-red-50 text-red-800" : "border-brand-300 bg-brand-50 text-brand-900"
            }`}
            title={impossible ? "The minimum is above the maximum, so nothing can match" : undefined}
          >
            <strong className="font-medium">{t.name}</strong>
            <span className="tabular-nums">{describeTraitRange(r, (v) => fmt(t, v))}</span>
            <button type="button" onClick={() => removeOne(r.code)} aria-label={`Remove the ${t.name} range`} className="text-current opacity-50 hover:opacity-100">✕</button>
          </span>
        );
      })}
    </div>
  );
}

function toDrafts(active: TraitRange[]): DraftRow[] {
  return active.map((r) => ({ code: r.code, min: r.min == null ? "" : String(r.min), max: r.max == null ? "" : String(r.max) }));
}

/**
 * The ONE bound formatter. Both catalogues feed it the same three facts —
 * decimals, unit, whether a "+" belongs — rather than each shipping its own
 * function, so a chip cannot come to disagree with the column beneath it.
 *
 * The "$" goes outside the sign ("$+500") to match formatUsTrait() in
 * key-traits.ts, which is what the table cells already do.
 */
function fmt(t: RangePickerTrait, v: number): string {
  const s = v.toFixed(t.decimals);
  const body = t.signed && v > 0 ? `+${s}` : s;
  if (t.unit === "$") return `$${body}`;
  return t.unit ? `${body} ${t.unit}` : body;
}

function toNum(s: string): number | null {
  const t = s.trim();
  if (!t || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
