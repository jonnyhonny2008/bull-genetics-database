"use client";

import { useEffect, useRef, useState } from "react";
import type { BullSearchHit } from "@/app/api/bull-search/route";

// ---------------------------------------------------------------------------
// "Link to animal" — a search box that submits an animal id inside a plain form.
//
// IT REPLACES A <select> THAT RENDERED THE WHOLE ROSTER. /uploads and /review
// each built one <option> per animal, and at 99,784 animals that was 22,912 KB
// of HTML on /uploads alone — the largest payload in the app, and paid on every
// page view so that somebody could pick at most one animal. Worse, it is
// serialised TWICE on a server-rendered page: once as HTML and again in the RSC
// flight data.
//
// IT STAYS FORM-COMPATIBLE. Both pages post to a server action that reads
// `animalId` off the FormData, so the selection is written into a real hidden
// input rather than held in React state alone. Submitting without choosing
// anything sends "", exactly as the old "— auto-match in review —" option did,
// and both actions already treat that as "no link".
// ---------------------------------------------------------------------------

export default function AnimalSelect({
  name = "animalId",
  /** Pre-selected animal, when the form is editing an existing link. */
  initial = null,
  /** Shown when nothing is chosen — the old <select>'s first option. */
  emptyLabel = "— auto-match in review —",
  className = "",
}: {
  name?: string;
  initial?: { id: string; name: string } | null;
  emptyLabel?: string;
  className?: string;
}) {
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(initial);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<BullSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      // scope=all: this picker links captures to ANY animal, cows included —
      // unlike the compare pages, which want sires.
      fetch(`/api/bull-search?system=ca&scope=all&q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((d: { hits: BullSearchHit[] }) => { setHits(d.hits ?? []); setOpen(true); })
        .catch(() => { /* aborted or offline — keep the last list */ })
        .finally(() => setBusy(false));
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      {/* The actual form field. Always present, so the action's FormData shape
          does not change whether or not anything is picked. */}
      <input type="hidden" name={name} value={chosen?.id ?? ""} />

      {chosen ? (
        <div className="flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5">
          <span className="flex-1 truncate text-sm text-slate-800">{chosen.name}</span>
          <button
            type="button"
            onClick={() => { setChosen(null); setQ(""); }}
            className="text-xs text-slate-400 hover:text-red-600"
            aria-label="Clear the linked animal"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => { if (hits.length) setOpen(true); }}
            onKeyDown={(e) => {
              // Enter must not submit the surrounding form while picking.
              if (e.key === "Enter") { e.preventDefault(); if (hits[0]) setChosen({ id: hits[0].id, name: hits[0].name }); setOpen(false); }
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search name, reg or NAAB…"
            className="input w-full"
            autoComplete="off"
          />
          {open && (
            <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
              {hits.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-400">{busy ? "Searching…" : `No animal matches “${q.trim()}”.`}</li>
              ) : (
                hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => { setChosen({ id: h.id, name: h.name }); setOpen(false); }}
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
          <p className="mt-1 text-[11px] text-slate-400">{emptyLabel}</p>
        </>
      )}
    </div>
  );
}
