import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, EmptyState, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getTraitFinderReport, type QueryableTrait } from "@/lib/trait-finder";

export const dynamic = "force-dynamic";

const ROWS = [1, 2, 3, 4, 5, 6];

function fmtVal(n: number | null): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

export default async function TraitFinderPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const report = await getTraitFinderReport(searchParams);
  const sp = searchParams;

  // Group the trait catalog for the dropdown <optgroup>s, preserving order.
  const groups: { label: string; traits: QueryableTrait[] }[] = [];
  for (const t of report.catalog) {
    let g = groups.find((x) => x.label === t.group);
    if (!g) { g = { label: t.group, traits: [] }; groups.push(g); }
    g.traits.push(t);
  }

  // Build a sortable-header link that flips dir on the active column and carries
  // every other control (conditions + scope) through untouched.
  const carry: [string, string][] = [];
  for (const r of ROWS) for (const k of [`t${r}`, `o${r}`, `v${r}`]) if (sp[k]) carry.push([k, sp[k] as string]);
  for (const k of ["breed", "blondin", "inactive", "q"]) if (sp[k]) carry.push([k, sp[k] as string]);
  const sortHref = (code: string) => {
    const p = new URLSearchParams(carry);
    p.set("sort", code);
    p.set("dir", report.sort === code && report.dir === "desc" ? "asc" : "desc");
    return `/reports/trait-finder?${p.toString()}`;
  };
  const arrow = (code: string) => (report.sort === code ? (report.dir === "desc" ? " ↓" : " ↑") : "");

  const hintFor = (code: string) => report.catalog.find((c) => c.code === code)?.hint ?? "";

  return (
    <div>
      <PageHeader
        title="Trait Finder"
        subtitle="Set a bar on one or more traits and get every bull that clears them all — long teats AND positive milk AND milking speed over 100, say. Leave a value blank for “just positive” (0 for most traits, 100 for the functional ratings). Reads each bull’s preferred proof; sort by any column."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Bulls matched" value={fmtNum(report.matched)} tone={report.matched ? "good" : "default"} hint={report.conditions.length ? `pass all ${report.conditions.length} condition${report.conditions.length === 1 ? "" : "s"}` : "no conditions set"} />
        <StatCard label="Bulls scanned" value={fmtNum(report.scanned)} hint={report.includeInactive ? "active + inactive" : "active lineup"} />
        <StatCard label="Conditions" value={report.conditions.length} hint="AND — all must pass" />
        <StatCard label="Sorted by" value={report.sort} hint={report.dir === "desc" ? "high → low" : "low → high"} />
      </div>

      {/* Condition builder */}
      <form method="get" className="card card-pad mt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Traits to require</div>
        <div className="space-y-2">
          {ROWS.map((r) => {
            const code = (sp[`t${r}`] ?? "").toUpperCase();
            return (
              <div key={r} className="flex flex-wrap items-center gap-2">
                <select name={`t${r}`} defaultValue={code} className="input min-w-[220px]">
                  <option value="">— trait —</option>
                  {groups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.traits.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
                    </optgroup>
                  ))}
                </select>
                <select name={`o${r}`} defaultValue={sp[`o${r}`] === "below" ? "below" : "above"} className="input">
                  <option value="above">is above</option>
                  <option value="below">is below</option>
                </select>
                <input
                  name={`v${r}`}
                  defaultValue={sp[`v${r}`] ?? ""}
                  inputMode="decimal"
                  placeholder={code ? `blank = ${report.catalog.find((c) => c.code === code)?.baseline ?? 0}` : "value (blank = positive)"}
                  className="input w-32"
                />
                {code && <span className="text-xs text-slate-400">{hintFor(code)}</span>}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
          <div>
            <label className="label" htmlFor="q">Search</label>
            <input id="q" name="q" defaultValue={report.q} placeholder="Name or NAAB…" className="input min-w-[180px]" />
          </div>
          <div>
            <label className="label">Breed</label>
            <select name="breed" defaultValue={report.breed} className="input">
              <option value="">All breeds</option>
              {report.breeds.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Lineup</label>
            <select name="blondin" defaultValue={report.blondin} className="input">
              <option value="">All bulls</option>
              <option value="only">Blondin only</option>
              <option value="exclude">Exclude Blondin</option>
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-slate-600" title="Include sires whose latest proof predates the most recent round on file.">
            <input type="checkbox" name="inactive" value="1" defaultChecked={report.includeInactive} />
            Include inactive
          </label>
          {/* Keep the current sort when re-running the query. */}
          {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
          {sp.dir && <input type="hidden" name="dir" value={sp.dir} />}
          <button type="submit" className="btn-primary">Find bulls</button>
          <Link href="/reports/trait-finder" className="btn-secondary">Reset</Link>
        </div>
      </form>

      {/* Results */}
      <div className="card mt-4">
        {report.conditions.length === 0 ? (
          <div className="card-pad"><EmptyState message="Add a trait condition above to search. For example: Teat Length above (blank), Milk above (blank), Milking Speed above 100." /></div>
        ) : report.rows.length === 0 ? (
          <div className="card-pad"><EmptyState message="No bulls in the current lineup clear all of those conditions. Loosen a threshold, or include inactive sires." /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th sticky left-0 z-10 bg-slate-50 text-left">Bull</th>
                  <th className="th text-left">Proof</th>
                  {report.columns.map((c) => {
                    const queried = report.conditions.some((cd) => cd.code === c.code);
                    return (
                      <th key={c.code} className={`th text-right ${queried ? "text-brand-700" : ""}`} title={hintFor(c.code)}>
                        <Link href={sortHref(c.code)} className="hover:underline">{c.code}{arrow(c.code)}</Link>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="td sticky left-0 z-10 bg-white">
                      <Link href={`/animals/${row.id}`} className="link font-medium">{row.name}</Link>
                      {row.naab && <span className="ml-2 text-xs text-slate-400">{row.naab}</span>}
                      {row.breed && <span className="ml-2 text-xs text-slate-400">{row.breed}</span>}
                    </td>
                    <td className="td whitespace-nowrap text-xs text-slate-500">
                      {row.proofRun ?? "—"}
                      <span className={`ml-1 rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${row.official ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500"}`}>
                        {row.official ? "official" : "interim"}
                      </span>
                    </td>
                    {report.columns.map((c) => {
                      const queried = report.conditions.some((cd) => cd.code === c.code);
                      return (
                        <td key={c.code} className={`td text-right tabular-nums ${queried ? "font-semibold text-slate-900" : "text-slate-600"}`}>
                          {fmtVal(row.values[c.code])}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
