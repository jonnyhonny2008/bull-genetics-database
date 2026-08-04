"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { LinearGraph, type LinearGroup } from "@/components/LinearGraph";

// --- shapes mirrored from /api/parent-average ---
interface ParentMeta {
  found: boolean; reg: string; name: string | null; sex: "M" | "F" | null;
  source: "internal" | "lactanet" | null; inDatabase: boolean;
  reliabilityOverall: number | null; basis: string | null; proofRun: string | null;
  traitCount: number; error?: string;
}
interface PARow { code: string; name: string; category: string | null; sire: number; dam: number; pa: number; }
interface Shared { reg: string; name: string | null; sirePath: string; damPath: string; sireGen: number; damGen: number; depth?: number; label?: string; }
interface Relatedness {
  tier: "excluded" | "clear" | "unknown" | "no-pedigree";
  depth: number; confidence: number; sireSlots: number; damSlots: number; note: string;
}
interface Ancestor { generation: number; side: "sire" | "dam"; reg: string | null; name: string | null; }
interface PAResult {
  ok: boolean; reason?: string; sire: ParentMeta; dam: ParentMeta;
  pa: PARow[]; descriptive: { code: string; name: string; sire: string; dam: string }[];
  unavailable: { code: string; name: string; availableFor: string }[]; shared: Shared[];
  relatedness?: Relatedness; notes: string[];
}
interface Mating { sire: ParentMeta; result: PAResult; linearGroups: LinearGroup[]; sireAncestors: Ancestor[]; damAncestors: Ancestor[]; }
interface PAResponse { ok: boolean; error?: string; dam: ParentMeta | null; matings: Mating[]; }

// Headline traits, in display order. Everything else falls under "All traits".
const KEY: [string, string][] = [
  ["LPI", "LPI"], ["PRO$", "Pro$"], ["CONF", "Conformation"],
  ["MILK", "Milk"], ["FAT", "Fat"], ["FATPCT", "Fat %"], ["PROT", "Protein"], ["PROTPCT", "Protein %"],
  ["MAMM", "Mammary System"], ["FL", "Feet & Legs"], ["DS", "Dairy Strength"], ["RUMP", "Rump"],
  ["MSPD", "Milking Speed"], ["DF", "Daughter Fertility"], ["HL", "Herd Life"], ["SCS", "SCS"],
];
const KEY_CODES = new Set(KEY.map((k) => k[0]));

const num = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n * 100) / 100));

function SourceTag({ p }: { p: ParentMeta }) {
  if (!p.found) return <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">not found</span>;
  if (p.inDatabase) return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">in database</span>;
  return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Lactanet · not saved</span>;
}

export default function MatingCalculator() {
  const [damReg, setDamReg] = useState("");
  const [sireRegs, setSireRegs] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<PAResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saveSel, setSaveSel] = useState<Record<string, boolean>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setSire = (i: number, v: string) => setSireRegs((a) => a.map((x, j) => (j === i ? v : x)));
  const addSire = () => setSireRegs((a) => (a.length < 5 ? [...a, ""] : a));
  const removeSire = (i: number) => setSireRegs((a) => (a.length > 1 ? a.filter((_, j) => j !== i) : a));

  async function calculate() {
    const sires = sireRegs.map((s) => s.trim()).filter(Boolean);
    if (!damReg.trim() || !sires.length) { setErr("Enter a dam and at least one sire registration number."); return; }
    setBusy(true); setErr(null); setResp(null); setSaveSel({}); setSaveMsg(null);
    try {
      const r = await fetch("/api/parent-average", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ damReg: damReg.trim(), sireRegs: sires }) });
      const data: PAResponse = await r.json();
      if (!r.ok || data.ok === false) setErr(data.error ?? "Calculation failed.");
      setResp(data);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  // Every real animal in the run (dam + sires), deduped. Ones already in the
  // database show as saved; ones looked up live from Lactanet get a save
  // checkbox (the `savable` subset).
  const involved = useMemo(() => {
    if (!resp) return [] as ParentMeta[];
    const seen = new Map<string, ParentMeta>();
    const consider = (p?: ParentMeta | null) => { if (p && p.found) seen.set(p.reg, p); };
    if (resp.dam) consider(resp.dam);
    resp.matings.forEach((m) => consider(m.sire));
    return [...seen.values()];
  }, [resp]);
  const savable = involved.filter((p) => !p.inDatabase && p.source === "lactanet");

  async function saveSelected() {
    const regs = savable.filter((p) => saveSel[p.reg]).map((p) => p.reg);
    if (!regs.length) { setSaveMsg("Tick at least one animal to import."); return; }
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch("/api/parent-average", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ save: regs }) });
      const d = await r.json();
      if (!r.ok) setSaveMsg(d.error ?? "Import failed.");
      else setSaveMsg(`Imported ${d.saved.filter((s: { ok: boolean }) => s.ok).length}/${regs.length}. Re-run the calculation to see them as “in database”.`);
    } catch (e) { setSaveMsg(String(e)); }
    finally { setSaving(false); }
  }

  const single = resp?.matings.length === 1 ? resp.matings[0] : null;

  return (
    <div className="space-y-5">
      {/* ---- input ---- */}
      <div className="card card-pad space-y-3">
        <div>
          <label className="label">Dam (female) — name or registration number</label>
          <input value={damReg} onChange={(e) => setDamReg(e.target.value)} placeholder="Name (in database) or reg e.g. HOCANF121135242" className="input" />
        </div>
        <div>
          <label className="label">Sire(s) (male) — name or reg #, up to 5 to compare against this dam</label>
          <div className="space-y-2">
            {sireRegs.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={s} onChange={(e) => setSire(i, e.target.value)} placeholder="Name (in database) or reg e.g. HOCANM13486161" className="input flex-1" />
                {sireRegs.length > 1 && <button type="button" onClick={() => removeSire(i)} className="btn-secondary btn-sm" aria-label="remove">✕</button>}
                {i === sireRegs.length - 1 && sireRegs.length < 5 && <button type="button" onClick={addSire} className="btn-secondary btn-sm whitespace-nowrap">+ sire</button>}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={calculate} disabled={busy} className="btn-primary">{busy ? "Calculating…" : "Calculate parent average"}</button>
          <span className="text-[11px] text-slate-400">A name searches the database; a registration number also looks it up live on Lactanet. Nothing is saved unless you tick it below.</span>
        </div>
        {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">{err}</div>}
      </div>

      {/* ---- save row: one line per real animal in the run ---- */}
      {involved.length > 0 && (
        <div className="card card-pad">
          <div className="mb-2 text-sm font-semibold text-slate-700">Animals in this calculation</div>
          <p className="mb-2 text-xs text-slate-500">
            Animals already in the database stay as they are. Ones looked up live from Lactanet are used for this
            calculation only — tick a box to import it, or leave it unticked and it&apos;s discarded.
          </p>
          <div className="flex flex-wrap gap-3">
            {involved.map((p) => (
              <label
                key={p.reg}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${p.inDatabase ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/40"}`}
              >
                {p.inDatabase ? (
                  <input type="checkbox" checked disabled title="Already in the database" />
                ) : (
                  <input type="checkbox" checked={!!saveSel[p.reg]} onChange={(e) => setSaveSel((s) => ({ ...s, [p.reg]: e.target.checked }))} />
                )}
                <span className="font-medium">{p.name ?? p.reg}</span>
                <span className="font-mono text-[10px] text-slate-400">{p.reg}</span>
                <span className={`rounded px-1 text-[9px] font-semibold uppercase ${p.inDatabase ? "text-emerald-700" : "text-amber-700"}`}>
                  {p.inDatabase ? "in database" : "save?"}
                </span>
              </label>
            ))}
          </div>
          {savable.length > 0 && (
            <div className="mt-2 flex items-center gap-3">
              <button type="button" onClick={saveSelected} disabled={saving} className="btn-primary btn-sm">{saving ? "Importing…" : "Import selected"}</button>
              {saveMsg && <span className="text-xs text-slate-500">{saveMsg}</span>}
            </div>
          )}
        </div>
      )}

      {/* ---- single mating: rich card ---- */}
      {single && single.result.ok && <SingleCard m={single} dam={resp!.dam!} />}

      {/* ---- multi-sire compare ---- */}
      {resp && resp.matings.length > 1 && <CompareTable dam={resp.dam} matings={resp.matings} />}

      {/* a mating that couldn't be computed */}
      {resp?.matings.map((m, i) => !m.result.ok && (
        <div key={i} className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="font-semibold">{m.sire.name ?? m.sire.reg} × {resp.dam?.name ?? "dam"}:</span> {m.result.reason}
        </div>
      ))}
    </div>
  );
}

function paClass(pa: number, sire: number, dam: number) {
  // colour the PA relative to the parent midpoint isn't meaningful; instead flag
  // sign for deviation-style traits where higher is generally better.
  return pa >= Math.max(sire, dam) ? "text-emerald-700" : pa <= Math.min(sire, dam) ? "text-slate-500" : "text-slate-700";
}

function SingleCard({ m, dam }: { m: Mating; dam: ParentMeta }) {
  const { result } = m;
  const byCode = new Map(result.pa.map((r) => [r.code, r]));
  const keyRows = KEY.map(([code, label]) => ({ code, label, row: byCode.get(code) })).filter((x) => x.row);
  const otherRows = result.pa.filter((r) => !KEY_CODES.has(r.code)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="card card-pad space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-brand-600">Projected progeny (parent average)</div>
          <div className="text-lg font-bold text-slate-800">{m.sire.name ?? m.sire.reg} <span className="text-slate-400">×</span> {dam.name ?? dam.reg}</div>
        </div>
        <div className="flex gap-4 text-xs">
          <div><span className="text-slate-400">Sire </span><SourceTag p={m.sire} /></div>
          <div><span className="text-slate-400">Dam </span><SourceTag p={dam} /></div>
        </div>
      </div>

      {/* key traits */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
            <th className="py-1 pr-4">Trait</th><th className="py-1 pr-4 text-right">Sire</th><th className="py-1 pr-4 text-right">Dam</th><th className="py-1 text-right">Parent Avg</th>
          </tr></thead>
          <tbody>
            {keyRows.map(({ code, label, row }) => (
              <tr key={code} className="border-t border-slate-100">
                <td className="py-1 pr-4 font-medium text-slate-700">{label}</td>
                <td className="py-1 pr-4 text-right tabular-nums text-slate-500">{num(row!.sire)}</td>
                <td className="py-1 pr-4 text-right tabular-nums text-slate-500">{num(row!.dam)}</td>
                <td className={`py-1 text-right font-semibold tabular-nums ${paClass(row!.pa, row!.sire, row!.dam)}`}>{num(row!.pa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* conformation linear graph — PA of the linear traits */}
      {m.linearGroups.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">Conformation — linear (parent average)</div>
          <LinearGraph groups={m.linearGroups} />
        </div>
      )}

      {/* calf pedigree (grandparents from each parent) */}
      <CalfPedigree sire={m.sire} dam={dam} sireAnc={m.sireAncestors} damAnc={m.damAncestors} />

      {/* shared relatives */}
      <div>
        <div className="mb-1 text-sm font-semibold text-slate-700">
          Shared relatives (nearest {result.relatedness?.depth ?? 3} generations of each parent)
        </div>
        {result.shared.length === 0 ? (
          // "Nothing found" and "we could not look" must never read the same.
          <p className={`text-xs ${result.relatedness?.tier === "clear" ? "text-emerald-700" : "text-amber-700"}`}>
            {result.relatedness?.note ?? "None found — but the depth of this check could not be established."}
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {result.shared.map((s) => (
              <li key={s.reg} className="flex flex-wrap items-center gap-x-2">
                <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">{s.name ?? s.reg}</span>
                <span className="font-mono text-[10px] text-slate-400">{s.reg}</span>
                <span className="text-slate-500">appears as the {s.sirePath} and the {s.damPath}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* other traits */}
      {otherRows.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-slate-600">All {result.pa.length} shared traits</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full">
              <tbody>
                {otherRows.map((r) => (
                  <tr key={r.code} className="border-t border-slate-50">
                    <td className="py-1 pr-4 text-slate-600">{r.name}</td>
                    <td className="py-1 pr-4 text-right tabular-nums text-slate-400">{num(r.sire)}</td>
                    <td className="py-1 pr-4 text-right tabular-nums text-slate-400">{num(r.dam)}</td>
                    <td className="py-1 text-right font-semibold tabular-nums text-slate-700">{num(r.pa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {result.unavailable.length > 0 && (
        <p className="text-[11px] text-slate-400">{result.unavailable.length} trait(s) held by only one parent (not averaged): {result.unavailable.slice(0, 12).map((u) => u.name).join(", ")}{result.unavailable.length > 12 ? "…" : ""}.</p>
      )}
      {result.notes.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
          {result.notes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}
    </div>
  );
}

function AncCell({ label, name, reg }: { label: string; name: string | null | undefined; reg: string | null | undefined }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-1.5 text-xs">
      <div className="text-[9px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-semibold text-slate-800">{name ?? <span className="text-slate-400">Unknown</span>}</div>
      {reg && <div className="font-mono text-[10px] text-slate-400">{reg}</div>}
    </div>
  );
}

function CalfPedigree({ sire, dam, sireAnc, damAnc }: { sire: ParentMeta; dam: ParentMeta; sireAnc: Ancestor[]; damAnc: Ancestor[] }) {
  const gp = (anc: Ancestor[], side: "sire" | "dam") => anc.find((a) => a.generation === 1 && a.side === side) ?? null;
  const pgs = gp(sireAnc, "sire"), pgd = gp(sireAnc, "dam"); // paternal grand-sire/-dam
  const mgs = gp(damAnc, "sire"), mgd = gp(damAnc, "dam");   // maternal grand-sire/-dam
  return (
    <div>
      <div className="mb-2 text-sm font-semibold text-slate-700">Pedigree of the projected calf</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <AncCell label="Sire" name={sire.name} reg={sire.reg} />
          <div className="grid grid-cols-2 gap-1.5 border-l-2 border-slate-100 pl-2">
            <AncCell label="Sire's sire" name={pgs?.name} reg={pgs?.reg} />
            <AncCell label="Sire's dam" name={pgd?.name} reg={pgd?.reg} />
          </div>
        </div>
        <div className="space-y-1.5">
          <AncCell label="Dam" name={dam.name} reg={dam.reg} />
          <div className="grid grid-cols-2 gap-1.5 border-l-2 border-slate-100 pl-2">
            <AncCell label="Dam's sire" name={mgs?.name} reg={mgs?.reg} />
            <AncCell label="Dam's dam" name={mgd?.name} reg={mgd?.reg} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CompareTable({ dam, matings }: { dam: ParentMeta | null; matings: Mating[] }) {
  const ok = matings.filter((m) => m.result.ok);
  const paByCode = (m: Mating) => new Map(m.result.pa.map((r) => [r.code, r.pa]));
  const maps = ok.map(paByCode);
  const damVal = (code: string) => ok[0]?.result.pa.find((r) => r.code === code)?.dam ?? null;
  const rows = KEY.filter(([code]) => maps.some((mp) => mp.has(code)));

  return (
    <div className="card overflow-x-auto">
      <div className="p-3 text-sm font-semibold text-slate-700">Compare {ok.length} sires against {dam?.name ?? dam?.reg} <span className="text-xs font-normal text-slate-400">— cell = parent average of that sire × this dam</span></div>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="th text-left">Trait</th>
            <th className="th text-right text-slate-400">Dam</th>
            {ok.map((m) => (
              <th key={m.sire.reg} className="th text-right" title={m.sire.reg}>
                {m.sire.name ?? m.sire.reg}
                <div className="font-normal"><SourceTag p={m.sire} /></div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([code, label]) => {
            const pas = maps.map((mp) => mp.get(code) ?? null);
            const best = Math.max(...pas.filter((v): v is number => v != null));
            return (
              <tr key={code} className="border-t border-slate-100">
                <td className="td font-medium text-slate-700">{label}</td>
                <td className="td text-right tabular-nums text-slate-400">{num(damVal(code))}</td>
                {pas.map((v, i) => (
                  <td key={i} className={`td text-right font-semibold tabular-nums ${v != null && v === best ? "bg-emerald-50 text-emerald-700" : "text-slate-700"}`}>{num(v)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="p-2 text-[11px] text-slate-400">Green = highest parent average for that trait among the compared sires. Higher is generally better except SCS.</p>
    </div>
  );
}
