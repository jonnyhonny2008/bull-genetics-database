"use client";

import { useState } from "react";
import { saveAnimal } from "./actions";
import { SEXES, COUNTRIES, ANIMAL_STATUSES, ID_TYPES } from "@/lib/constants";

interface IdRow {
  idType: string;
  idValue: string;
  issuingCountry: string;
  issuingOrganization: string;
  sourceId: string;
  isPrimary: boolean;
}

interface Props {
  breeds: { breedId: string; breedName: string }[];
  sources: { sourceId: string; sourceName: string }[];
  animal?: {
    id: string; primaryName: string; shortName: string | null; sex: string; breedId: string | null;
    birthDate: string | null; countryOfOrigin: string | null; currentStatus: string; notes: string | null;
    identifiers: IdRow[];
  };
}

export function AnimalForm({ breeds, sources, animal }: Props) {
  const [ids, setIds] = useState<IdRow[]>(
    animal?.identifiers.length
      ? animal.identifiers
      : [{ idType: "registration_ca", idValue: "", issuingCountry: "CA", issuingOrganization: "", sourceId: "", isPrimary: true }],
  );
  function updateId(i: number, patch: Partial<IdRow>) {
    setIds((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addId() {
    setIds((prev) => [...prev, { idType: "naab", idValue: "", issuingCountry: "", issuingOrganization: "", sourceId: "", isPrimary: prev.length === 0 }]);
  }
  function removeId(i: number) {
    setIds((prev) => prev.filter((_, idx) => idx !== i));
  }
  const primaryIndex = Math.max(0, ids.findIndex((r) => r.isPrimary));

  return (
    <form action={saveAnimal} className="space-y-4">
      {animal && <input type="hidden" name="id" value={animal.id} />}

      <div className="card card-pad">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Core details</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="md:col-span-2">
            <label className="label">Primary name *</label>
            <input name="primaryName" required defaultValue={animal?.primaryName} className="input" />
          </div>
          <div>
            <label className="label">Short name</label>
            <input name="shortName" defaultValue={animal?.shortName ?? ""} className="input" />
          </div>
          <div>
            <label className="label">Sex *</label>
            <select name="sex" defaultValue={animal?.sex ?? "F"} className="input">
              {Object.entries(SEXES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Breed</label>
            <select name="breedId" defaultValue={animal?.breedId ?? ""} className="input">
              <option value="">— none —</option>
              {breeds.map((b) => <option key={b.breedId} value={b.breedId}>{b.breedName}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Birth date</label>
            <input type="date" name="birthDate" defaultValue={animal?.birthDate ?? ""} className="input" />
          </div>
          <div>
            <label className="label">Country of origin</label>
            <select name="countryOfOrigin" defaultValue={animal?.countryOfOrigin ?? "CA"} className="input">
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select name="currentStatus" defaultValue={animal?.currentStatus ?? "active"} className="input">
              {ANIMAL_STATUSES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="label">Notes</label>
            <textarea name="notes" defaultValue={animal?.notes ?? ""} rows={2} className="input" />
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Identifiers</h2>
          <button type="button" onClick={addId} className="btn-secondary btn-sm">+ Add identifier</button>
        </div>
        <input type="hidden" name="primaryIndex" value={primaryIndex} />
        <div className="space-y-2">
          {ids.map((row, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2 rounded-md border border-slate-200 p-2">
              <div className="col-span-3">
                <select value={row.idType} name="idType" onChange={(e) => updateId(i, { idType: e.target.value })} className="input">
                  {ID_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              </div>
              <div className="col-span-3">
                <input value={row.idValue} name="idValue" onChange={(e) => updateId(i, { idValue: e.target.value })} placeholder="Value" className="input" />
              </div>
              <div className="col-span-2">
                <input value={row.issuingCountry} name="idCountry" onChange={(e) => updateId(i, { issuingCountry: e.target.value })} placeholder="Country" className="input" />
              </div>
              <div className="col-span-2">
                <select value={row.sourceId} name="idSource" onChange={(e) => updateId(i, { sourceId: e.target.value })} className="input">
                  <option value="">Source…</option>
                  {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
                </select>
              </div>
              <input type="hidden" name="idOrg" value={row.issuingOrganization} />
              <div className="col-span-1 flex items-center justify-center">
                <label className="flex flex-col items-center text-[10px] text-slate-500">
                  primary
                  <input type="radio" name="primaryRadio" checked={i === primaryIndex} onChange={() => setIds((prev) => prev.map((r, idx) => ({ ...r, isPrimary: idx === i })))} />
                </label>
              </div>
              <div className="col-span-1 text-right">
                <button type="button" onClick={() => removeId(i)} className="text-xs text-red-600 hover:underline">remove</button>
              </div>
            </div>
          ))}
          {ids.length === 0 && <p className="text-xs text-slate-400">No identifiers. Add at least one for reliable matching.</p>}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">The internal system ID is generated automatically and never changes — external identifiers above are stored separately.</p>
      </div>

      <div className="card card-pad">
        <h2 className="mb-1 text-sm font-semibold text-slate-700">Sire role</h2>
        <p className="text-xs text-slate-500">
          Not editable by hand. Proven vs genomic comes from the Lactanet proof activity code on each
          imported round, and active vs inactive from whether the sire appears in the most recent round on
          file. Both are recalculated on every proof import.
        </p>
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary">{animal ? "Save changes" : "Create animal"}</button>
        <a href={animal ? `/animals/${animal.id}` : "/animals"} className="btn-secondary">Cancel</a>
      </div>
    </form>
  );
}
