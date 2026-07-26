import { SEXES, COUNTRIES, ANIMAL_STATUSES } from "@/lib/constants";
import { SireRoleField } from "@/components/SireFilters";
import { SIRE_SORTS } from "@/lib/sire-class";

// Native GET form — updates the URL query string, no client JS required.
export function AnimalFilters({
  breeds,
  sources,
  traitDefs,
  sp,
}: {
  breeds: { breedId: string; breedName: string }[];
  sources: { sourceId: string; sourceName: string }[];
  traitDefs: { traitCode: string; traitName: string; category: string | null }[];
  sp: Record<string, string | undefined>;
}) {
  // Group traits by category for the "Sort by" dropdown.
  const groups = new Map<string, { traitCode: string; traitName: string }[]>();
  for (const t of traitDefs) {
    const c = t.category ?? "Other";
    const arr = groups.get(c) ?? [];
    arr.push(t);
    groups.set(c, arr);
  }

  return (
    <form method="get" className="card card-pad mb-4">
      <div className="mb-3 flex flex-wrap items-end gap-3 border-b border-slate-100 pb-3">
        <div>
          <label className="label">Sort by</label>
          <select name="sort" defaultValue={sp.sort ?? "name"} className="input min-w-[180px]">
            {/* The three sorts every list shares, then every other trait. */}
            <optgroup label="Lineup">
              {SIRE_SORTS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </optgroup>
            {[...groups.entries()].map(([cat, list]) => (
              <optgroup key={cat} label={cat}>
                {list.map((t) => <option key={t.traitCode} value={t.traitCode}>{t.traitName}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Order</label>
          <select name="dir" defaultValue={sp.dir ?? "desc"} className="input">
            <option value="desc">High → Low</option>
            <option value="asc">Low → High</option>
          </select>
        </div>
        <SireRoleField value={sp.role} />
        <div className="text-xs text-slate-400">Sort by LPI, Conformation, birth date, or any other trait.</div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <div className="col-span-2">
          <label className="label">Search (name / reg / NAAB / semen / tattoo)</label>
          <input name="q" defaultValue={sp.q} className="input" placeholder="e.g. Thunder or 007HO16123" />
        </div>
        <div>
          <label className="label">Breed</label>
          <select name="breed" defaultValue={sp.breed ?? ""} className="input">
            <option value="">All</option>
            {breeds.map((b) => <option key={b.breedId} value={b.breedId}>{b.breedName}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Sex</label>
          <select name="sex" defaultValue={sp.sex ?? ""} className="input">
            <option value="">All</option>
            {Object.entries(SEXES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select name="status" defaultValue={sp.status ?? ""} className="input">
            <option value="">All</option>
            {ANIMAL_STATUSES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Country</label>
          <select name="country" defaultValue={sp.country ?? ""} className="input">
            <option value="">All</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Source</label>
          <select name="source" defaultValue={sp.source ?? ""} className="input">
            <option value="">All</option>
            {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Birth year</label>
          <input name="year" defaultValue={sp.year} className="input" placeholder="e.g. 2021" />
        </div>
        <div>
          <label className="label">Trait code</label>
          <input name="trait" defaultValue={sp.trait} className="input" placeholder="e.g. LPI" />
        </div>
        <div>
          <label className="label">Trait ≥</label>
          <input name="traitMin" defaultValue={sp.traitMin} className="input" placeholder="e.g. 3400" />
        </div>
        <div>
          <label className="label">Class. score ≥</label>
          <input name="classMin" defaultValue={sp.classMin} className="input" placeholder="e.g. 85" />
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" name="missingId" value="1" defaultChecked={sp.missingId === "1"} /> Missing primary ID
          </label>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" name="pendingReview" value="1" defaultChecked={sp.pendingReview === "1"} /> Has pending review
          </label>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input type="checkbox" name="noProof" value="1" defaultChecked={sp.noProof === "1"} /> No genetic proof
          </label>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button className="btn-primary" type="submit">Apply filters</button>
        <a href="/animals" className="btn-secondary">Reset</a>
      </div>
    </form>
  );
}
