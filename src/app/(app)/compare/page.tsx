import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, EmptyState, Badge } from "@/components/ui";
import { unpackTraits, type TraitDefLite } from "@/lib/eval-traits";
import { fmtNum } from "@/lib/format";
import ComparePicker from "@/components/ComparePicker";

export const dynamic = "force-dynamic";

const MAX = 6;
// Indices read as a plain number; EBV deviations read with an explicit +/- sign.
const INDEX_CODES = new Set(["LPI", "PRO$", "PI", "LTI", "HWI", "RI", "MI", "EI"]);

function fmtTrait(code: string, v: number | null | undefined): string {
  if (v == null) return "—";
  const isPct = code === "FATPCT" || code === "PROTPCT";
  const s = isPct ? v.toFixed(2) : fmtNum(Math.round(v));
  return !INDEX_CODES.has(code) && v > 0 ? `+${s}` : s;
}

export default async function ComparePage({ searchParams }: { searchParams: { bulls?: string } }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const ids = (searchParams.bulls ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX);

  const [richDefs, allBulls, animals] = await Promise.all([
    prisma.traitDefinition.findMany({
      where: { domain: "genetic" },
      select: { traitCode: true, traitName: true, category: true, unit: true, displayOrder: true, higherIsBetter: true },
    }),
    prisma.animal.findMany({
      where: { sex: "M", archived: false },
      orderBy: { primaryName: "asc" },
      select: { id: true, primaryName: true },
    }),
    ids.length
      ? prisma.animal.findMany({
          where: { id: { in: ids } },
          select: {
            id: true, primaryName: true, shortName: true, sireType: true, proofStatus: true,
            breed: { select: { breedCode: true } },
            identifiers: { where: { idType: "naab", active: true }, select: { idValue: true }, take: 1 },
            evaluations: { where: { isPreferred: true }, take: 1, select: { traitsJson: true, proofRun: true, runKind: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const defMap = new Map<string, TraitDefLite>(richDefs.map((d) => [d.traitCode, { name: d.traitName, category: d.category, unit: d.unit, order: d.displayOrder }]));
  const dirMap = new Map(richDefs.map((d) => [d.traitCode, d.higherIsBetter]));

  // Preserve the order the bulls were listed in the URL.
  const byId = new Map(animals.map((a) => [a.id, a]));
  const bulls = ids.map((id) => byId.get(id)).filter((b): b is (typeof animals)[number] => Boolean(b));
  const selected = bulls.map((b) => ({ id: b.id, name: b.primaryName }));

  // code -> value per bull.
  const valueMaps = bulls.map((b) => {
    const ev = b.evaluations[0];
    const m = new Map<string, number>();
    for (const t of unpackTraits(ev?.traitsJson, defMap)) if (t.numericValue != null) m.set(t.traitCode, t.numericValue);
    return m;
  });

  // Rows = every trait any of the bulls carries, in the trait catalogue's order,
  // grouped by category.
  const shown = new Set<string>();
  valueMaps.forEach((m) => m.forEach((_v, k) => shown.add(k)));
  const orderedDefs = richDefs
    .filter((d) => shown.has(d.traitCode))
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const groups: { category: string; codes: { code: string; name: string }[] }[] = [];
  for (const d of orderedDefs) {
    const cat = d.category ?? "Other";
    let g = groups.find((x) => x.category === cat);
    if (!g) { g = { category: cat, codes: [] }; groups.push(g); }
    g.codes.push({ code: d.traitCode, name: d.traitName });
  }

  // Best value(s) in a row: the max (or min for lower-is-better) when the bulls
  // actually differ. Ties at the top are all highlighted; an all-equal row isn't.
  const bestOf = (code: string): number | null => {
    const vals = valueMaps.map((m) => m.get(code)).filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    const max = Math.max(...vals), min = Math.min(...vals);
    if (max === min) return null;
    return dirMap.get(code) === false ? min : max;
  };

  return (
    <div>
      <PageHeader
        title="Compare bulls"
        subtitle="Put bulls side by side across every trait. The best value in each row is highlighted."
      />

      <div className="mb-4">
        <ComparePicker selected={selected} all={allBulls.map((b) => ({ id: b.id, name: b.primaryName }))} max={MAX} />
      </div>

      {bulls.length < 2 ? (
        <EmptyState message={bulls.length === 1 ? "Add at least one more bull to compare." : "Pick two or more bulls above to compare them side by side."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-3 text-left font-semibold text-slate-500">Trait</th>
                {bulls.map((b) => (
                  <th key={b.id} className="min-w-[10rem] px-3 py-3 text-left align-top">
                    <Link href={`/animals/${b.id}`} className="font-semibold text-brand-700 hover:underline">{b.primaryName}</Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {b.sireType === "proven" ? <Badge tone="green">Proven</Badge> : b.sireType === "genomic" ? <Badge tone="blue">Genomic</Badge> : null}
                      {b.proofStatus === "active" ? <Badge tone="brand">Active</Badge> : <Badge>Inactive</Badge>}
                    </div>
                    <div className="mt-1 text-[11px] font-normal text-slate-500">
                      {b.identifiers[0]?.idValue ? <span>{b.identifiers[0].idValue} · </span> : null}
                      {b.breed?.breedCode ?? ""}{b.evaluations[0]?.proofRun ? ` · ${b.evaluations[0].proofRun}` : ""}
                      {b.evaluations[0]?.runKind ? ` (${b.evaluations[0].runKind})` : ""}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.category}>
                  <tr className="bg-slate-100/70">
                    <td colSpan={bulls.length + 1} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.category}</td>
                  </tr>
                  {g.codes.map((row) => {
                    const best = bestOf(row.code);
                    return (
                      <tr key={row.code} className="border-b border-slate-100">
                        <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium text-slate-700">{row.name}</th>
                        {valueMaps.map((m, i) => {
                          const v = m.get(row.code) ?? null;
                          const isBest = best != null && v === best;
                          return (
                            <td
                              key={bulls[i].id}
                              className={`px-3 py-2 tabular-nums ${isBest ? "bg-emerald-50 font-semibold text-emerald-800" : "text-slate-700"}`}
                            >
                              {fmtTrait(row.code, v)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
