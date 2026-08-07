"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveUsSearch, deleteUsSavedSearch } from "@/app/(app)/us/saved-search-actions";

// Save the current American lineup view (its querystring) under a name, and jump
// back to any saved view. Same shape as the Canadian SavedSearches component, but
// wired to the US actions so a save from this page can only ever write a /us/ row.
export default function UsSavedSearches({
  path,
  currentQuery,
  searches,
}: {
  path: string;
  currentQuery: string;
  searches: { id: string; name: string; query: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = () => {
    const nm = name.trim();
    if (!nm) return;
    start(async () => {
      await saveUsSearch(nm, path, currentQuery);
      setName("");
      setNaming(false);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {searches.length > 0 && <span className="text-xs font-medium text-slate-500">Saved:</span>}
      {searches.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
          <Link href={`${path}?${s.query}`} className="font-medium hover:text-brand-700 hover:underline">{s.name}</Link>
          <button
            type="button"
            aria-label={`Delete saved search ${s.name}`}
            title="Delete"
            disabled={pending}
            onClick={() => start(async () => { await deleteUsSavedSearch(s.id); router.refresh(); })}
            className="ml-0.5 rounded-full px-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          >
            ×
          </button>
        </span>
      ))}

      {naming ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") { setNaming(false); setName(""); } }}
            placeholder="Name this view…"
            className="w-40 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button type="button" onClick={save} disabled={pending || !name.trim()} className="btn-primary btn-sm">Save</button>
          <button type="button" onClick={() => { setNaming(false); setName(""); }} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={!currentQuery}
          title={currentQuery ? "Save the current filters as a named view" : "Apply some filters first"}
          className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:border-brand-400 hover:text-brand-700 disabled:opacity-40"
        >
          ＋ Save this view
        </button>
      )}
    </div>
  );
}
