"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BullSearchHit } from "@/app/api/bull-search/route";

// ---------------------------------------------------------------------------
// The bull chooser on both compare pages.
//
// Selection lives entirely in the URL (?bulls=id,id) so a comparison is
// shareable and back/forward works; this component only edits that list.
//
// IT USED TO RECEIVE THE WHOLE ROSTER. Two near-identical components each took
// an `all` prop holding every bull, so the browser could filter a native
// <datalist> without a round-trip. That was a fair trade at the few hundred
// bulls the old comment described ("~900 names"); at today's 63,052 Canadian
// animals and 68,721 American evaluations it meant /compare shipped 10,977 KB
// and /us/compare 8,035 KB of HTML — and the American picker's query alone took
// 13.4 seconds — so that somebody could type six letters.
//
// Now it asks the server (/api/bull-search) and shows at most 20 matches.
//
// ONE COMPONENT, TWO SYSTEMS. The countries differ in which table they search
// and which id they return, and both of those live behind `system`. They do not
// differ in what picking a bull MEANS, so a second copy of this file would only
// be a second place for the two to drift apart.
// ---------------------------------------------------------------------------

export default function BullComparePicker({
  selected,
  system,
  basePath,
  max = 6,
}: {
  selected: { id: string; name: string }[];
  /** Which roster to search, and therefore which flavour of id comes back. */
  system: "ca" | "us";
  /** Where to push the new selection — "/compare" or "/us/compare". */
  basePath: string;
  max?: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<BullSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const selectedIds = new Set(selected.map((s) => s.id));
  const boxRef = useRef<HTMLDivElement>(null);

  const go = (ids: string[]) => router.push(ids.length ? `${basePath}?bulls=${ids.join(",")}` : basePath);
  const add = (id: string) => {
    if (!id || selectedIds.has(id) || selected.length >= max) return;
    go([...selected.map((s) => s.id), id]);
    setQ("");
    setHits([]);
    setOpen(false);
  };
  const remove = (id: string) => go(selected.filter((s) => s.id !== id).map((s) => s.id));

  // Debounced search. The abort controller matters more than the delay: without
  // it a slow response to "PE" can land after the fast one to "PEAK" and replace
  // a correct list with a stale one.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      fetch(`/api/bull-search?system=${system}&q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((d: { hits: BullSearchHit[] }) => { setHits(d.hits ?? []); setOpen(true); })
        .catch(() => { /* aborted or offline — leave the last list alone */ })
        .finally(() => setBusy(false));
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, system]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const available = hits.filter((h) => !selectedIds.has(h.id));

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-800">
            {s.name}
            <button
              type="button"
              onClick={() => remove(s.id)}
              aria-label={`Remove ${s.name}`}
              className="ml-0.5 rounded-full px-1 text-brand-600 hover:bg-brand-200 hover:text-brand-900"
            >
              ×
            </button>
          </span>
        ))}

        {selected.length < max ? (
          <div ref={boxRef} className="relative min-w-[18rem] flex-1">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onFocus={() => { if (available.length) setOpen(true); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (available[0]) add(available[0].id); }
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder={selected.length ? "Add another bull…" : "Search by name, NAAB or registration…"}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              autoComplete="off"
            />

            {open && (
              <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
                {available.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-slate-400">
                    {busy ? "Searching…" : `No bull matches “${q.trim()}”.`}
                  </li>
                ) : (
                  available.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        onClick={() => add(h.id)}
                        className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-brand-50"
                      >
                        <span className="text-sm text-slate-800">{h.name}</span>
                        {h.hint && <span className="font-mono text-[10px] text-slate-400">{h.hint}</span>}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-500">Up to {max} bulls — remove one to add another.</span>
        )}
      </div>

      {q.trim().length === 1 && (
        <p className="mt-1.5 text-[11px] text-slate-400">Keep typing — search starts at two characters.</p>
      )}
    </div>
  );
}
