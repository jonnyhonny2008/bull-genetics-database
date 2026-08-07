"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// The bull chooser on /us/compare.
//
// A near-copy of ComparePicker rather than a shared component, because that one
// pushes the Canadian `/compare` route directly. The system a page belongs to is
// carried in the URL (see genetic-system.ts) — so a picker that navigated to
// `/compare` from the American side would silently drop the user into Lactanet
// EBVs in kilograms while the page still said American. Editing ComparePicker to
// take a base path would put that decision one prop away from being got wrong on
// the live Canadian page; a separate file cannot regress it.
//
// Selection lives entirely in the URL (?bulls=id,id) so a comparison is shareable
// and back/forward works. All bulls are passed in for a native datalist, so typing
// filters them client-side without a round-trip.
export default function UsComparePicker({
  selected,
  all,
  max = 6,
}: {
  selected: { id: string; name: string }[];
  all: { id: string; name: string }[];
  max?: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const selectedIds = new Set(selected.map((s) => s.id));

  const go = (ids: string[]) => router.push(ids.length ? `/us/compare?bulls=${ids.join(",")}` : "/us/compare");
  const add = (id: string) => {
    if (!id || selectedIds.has(id) || selected.length >= max) return;
    go([...selected.map((s) => s.id), id]);
    setQ("");
  };
  const remove = (id: string) => go(selected.filter((s) => s.id !== id).map((s) => s.id));

  // A datalist pick sets the input to the exact option label; match it back to an id.
  const tryAdd = (val: string) => {
    const m = all.find((a) => a.name === val);
    if (m) add(m.id);
  };

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
          <>
            <input
              list="us-compare-bull-options"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                tryAdd(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); tryAdd((e.target as HTMLInputElement).value); }
              }}
              placeholder={selected.length ? "Add another bull…" : "Add a bull to compare…"}
              className="min-w-[16rem] flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <datalist id="us-compare-bull-options">
              {all.filter((a) => !selectedIds.has(a.id)).map((a) => (
                <option key={a.id} value={a.name} />
              ))}
            </datalist>
          </>
        ) : (
          <span className="text-xs text-slate-500">Up to {max} bulls — remove one to add another.</span>
        )}
      </div>
    </div>
  );
}
