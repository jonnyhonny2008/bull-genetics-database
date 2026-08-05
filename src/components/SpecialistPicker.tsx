"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export interface PickerTrait { code: string; name: string; group: string }

/**
 * "Specialists" dropdown for the Animals list: tick a few traits and the list
 * narrows to bulls that are solidly positive for all of them. Writes `spec`
 * (comma-separated codes) and `specLevel` into the URL, preserving every other
 * filter, and lets the server do the actual narrowing.
 */
export function SpecialistPicker({ traits }: { traits: PickerTrait[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);

  const active = useMemo(() => new Set((sp.get("spec") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)), [sp]);
  const [sel, setSel] = useState<Set<string>>(active);
  const [level, setLevel] = useState(sp.get("specLevel") ?? "solid");

  const groups = useMemo(() => {
    const m = new Map<string, PickerTrait[]>();
    for (const t of traits) { const a = m.get(t.group) ?? []; a.push(t); m.set(t.group, a); }
    return [...m.entries()];
  }, [traits]);

  const toggle = (code: string) => setSel((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });

  function apply() {
    const params = new URLSearchParams(sp.toString());
    params.delete("page");
    if (sel.size) { params.set("spec", [...sel].join(",")); params.set("specLevel", level); }
    else { params.delete("spec"); params.delete("specLevel"); }
    router.push(`/animals?${params.toString()}`);
    setOpen(false);
  }
  function clear() {
    setSel(new Set());
    const params = new URLSearchParams(sp.toString());
    params.delete("spec"); params.delete("specLevel"); params.delete("page");
    router.push(`/animals?${params.toString()}`);
    setOpen(false);
  }

  return (
    <div className="relative mb-3 inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`btn-sm ${active.size ? "btn-primary" : "btn-secondary"}`}
        title="Find bulls that are solidly positive for the traits you pick"
      >
        ★ Specialists{active.size ? ` · ${active.size} trait${active.size === 1 ? "" : "s"}` : ""} ▾
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-[340px] rounded-md border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-2 text-xs text-slate-500">
            Bulls with <strong>solidly positive</strong> values for every trait you tick — a specialist across all of them.
          </div>
          <div className="mb-2 flex items-center gap-2">
            <label className="text-xs font-medium text-slate-600">Bar</label>
            <select value={level} onChange={(e) => setLevel(e.target.value)} className="input input-sm flex-1">
              <option value="positive">Positive (above neutral)</option>
              <option value="solid">Solidly positive (½ SD above average)</option>
              <option value="strong">Strong (1 SD above average)</option>
            </select>
          </div>
          <div className="max-h-64 overflow-y-auto pr-1">
            {groups.map(([g, list]) => (
              <div key={g} className="mb-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{g}</div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                  {list.map((t) => (
                    <label key={t.code} className="flex items-center gap-1.5 text-xs text-slate-700">
                      <input type="checkbox" checked={sel.has(t.code)} onChange={() => toggle(t.code)} />
                      <span className="truncate" title={t.name}>{t.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
            <button type="button" onClick={clear} className="text-xs text-slate-500 hover:underline">Clear</button>
            <div className="flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className="btn-secondary btn-sm">Cancel</button>
              <button type="button" onClick={apply} className="btn-primary btn-sm">Show specialists</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
