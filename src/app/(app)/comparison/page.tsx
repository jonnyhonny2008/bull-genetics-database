import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { PageHeader, Card, EmptyState } from "@/components/ui";
import { fmtDate, fmtNum } from "@/lib/format";
import { loadRankMap, pickPreferred } from "@/lib/priority";
import { attachTraits, traitDefMap } from "@/lib/eval-traits";
import { SEXES } from "@/lib/constants";
import { SireRoleField, SireSortField, SireRolePills, SireClassBadges } from "@/components/SireFilters";
import { sireRoleWhere, resolveSort } from "@/lib/sire-class";
import { sireRoleCounts } from "@/lib/sire-rank";

export const dynamic = "force-dynamic";

const PICK_LIMIT = 200;

export default async function ComparisonPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const sp = searchParams;
  // The picker submits one `ids` checkbox per animal, so Next hands back a string
  // for a single selection and an array for several. Handle both — treating the
  // array case as a string used to throw on any multi-animal comparison.
  const rawIds = sp.ids as unknown;
  const selectedIds = (Array.isArray(rawIds) ? rawIds.map(String) : String(rawIds ?? "").split(","))
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  // Picker: first 200 by the chosen sort, plus any already-selected animals (so
  // they stay checkable). For large herds, add animals via the "Compare" button
  // on a profile or the Animals search. Scales past ~100k rows.
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const sortDef = resolveSort(sp.sort);
  const roleWhere = sireRoleWhere(sp.role) as Prisma.AnimalWhereInput | null;
  const pickWhere: Prisma.AnimalWhereInput = { AND: [{ archived: false }, ...(roleWhere ? [roleWhere] : [])] };
  const pickSelect = {
    id: true, primaryName: true, sireType: true, proofStatus: true, latestActivityCode: true,
    breed: { select: { breedName: true } },
  };

  // LPI / Conformation come off the preferred evaluation, so drive the picker
  // from that side when sorting by a trait.
  const browsePromise = sortDef?.kind === "eval"
    ? prisma.geneticEvaluation
        .findMany({
          where: { isPreferred: true, [sortDef.col]: { not: null }, animal: pickWhere },
          orderBy: { [sortDef.col]: dir }, take: PICK_LIMIT,
          select: { animal: { select: pickSelect } },
        })
        .then((rows) => rows.map((r) => r.animal))
    : prisma.animal.findMany({
        where: pickWhere,
        orderBy: sortDef?.code === "birth" ? { birthDate: { sort: dir, nulls: "last" } } : { primaryName: sortDef?.code === "name" ? dir : "asc" },
        take: PICK_LIMIT, select: pickSelect,
      });

  const [browseAnimals, selectedForPicker, roleCounts] = await Promise.all([
    browsePromise,
    selectedIds.length ? prisma.animal.findMany({ where: { id: { in: selectedIds } }, select: pickSelect }) : Promise.resolve([]),
    sireRoleCounts({ archived: false }),
  ]);
  // Selected animals lead so they are never scrolled off; the browse list keeps
  // whatever order the sort produced.
  const pickerMap = new Map<string, (typeof browseAnimals)[number]>();
  for (const a of [...selectedForPicker, ...browseAnimals]) pickerMap.set(a.id, a);
  const allAnimals = [...pickerMap.values()];

  const [geRank, mkRank, clRank, traitDefs] = await Promise.all([
    loadRankMap("genetic_evaluation"),
    loadRankMap("milk_record"),
    loadRankMap("classification"),
    prisma.traitDefinition.findMany({ where: { domain: "genetic" }, orderBy: { displayOrder: "asc" } }),
  ]);

  const selected = selectedIds.length
    ? await prisma.animal.findMany({
        where: { id: { in: selectedIds } },
        include: {
          breed: true,
          identifiers: true,
          evaluations: { where: { approvalStatus: "approved" }, include: { source: true } },
          milkRecords: { where: { approvalStatus: "approved" } },
          classifications: { where: { approvalStatus: "approved" }, include: { source: true } },
        },
      })
    : [];
  // Preserve the order given in the URL.
  selected.sort((a, b) => selectedIds.indexOf(a.id) - selectedIds.indexOf(b.id));

  // Rebuild traitValues from packed storage.
  const defMap = await traitDefMap();
  const withEvals = selected.map((a) => ({ ...a, evaluations: attachTraits(a.evaluations, defMap) }));

  // Compute preferred records per animal.
  const prof = withEvals.map((a) => {
    const proof = pickPreferred(a.evaluations, { getSourceId: (e) => e.sourceId, getDate: (e) => e.evaluationDate, getApproval: (e) => e.approvalStatus, rankMap: geRank, domainLabel: "genetic evaluations" }).chosen;
    const cls = pickPreferred(a.classifications, { getSourceId: (c) => c.sourceId, getDate: (c) => c.classificationDate, getApproval: (c) => c.approvalStatus, rankMap: clRank, domainLabel: "classification" }).chosen;
    // best milk = highest milkAmount among approved
    const milk = [...a.milkRecords].sort((x, y) => (y.milkAmount ?? 0) - (x.milkAmount ?? 0))[0] ?? null;
    return { animal: a, proof, cls, milk };
  });

  // Union of trait codes present in any selected animal's preferred proof.
  const presentCodes = new Set<string>();
  for (const p of prof) for (const t of p.proof?.traitValues ?? []) presentCodes.add(t.traitCode);
  const traitRows = traitDefs.filter((d) => presentCodes.has(d.traitCode));

  function traitVal(p: (typeof prof)[number], code: string) {
    const t = p.proof?.traitValues.find((v) => v.traitCode === code);
    return t ? (t.numericValue ?? t.textValue ?? "—") : "—";
  }

  return (
    <div>
      <PageHeader title="Animal Comparison" subtitle="Select animals to compare side by side on identifiers, preferred proof traits, classification, and production." />

      <SireRolePills basePath="/comparison" sp={sp} counts={roleCounts} />

      {/* Narrowing the picker. Separate from the selection form below, because
          HTML forbids nesting one form inside another. */}
      <form method="get" className="card card-pad mb-4 flex flex-wrap items-end gap-3">
        {selectedIds.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
        <SireRoleField value={sp.role} />
        <SireSortField sort={sp.sort} dir={sp.dir} />
        <button type="submit" className="btn-primary">Apply</button>
        <a href="/comparison" className="btn-secondary">Reset</a>
      </form>

      {/* Selector */}
      <Card title={`Select animals — showing ${allAnimals.length}${sortDef ? ` by ${sortDef.label}` : " A→Z"}`} className="mb-4">
        <form method="get">
          {sp.role && <input type="hidden" name="role" value={sp.role} />}
          {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
          {sp.dir && <input type="hidden" name="dir" value={sp.dir} />}
          <div className="grid max-h-52 grid-cols-2 gap-1 overflow-y-auto md:grid-cols-4">
            {allAnimals.map((a) => (
              <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                <input type="checkbox" name="ids" value={a.id} defaultChecked={selectedIds.includes(a.id)} />
                <span className="truncate">
                  {a.primaryName} <span className="text-xs text-slate-400">{a.breed?.breedName ?? ""}</span>
                  {a.sireType && <span className={`ml-1 text-[10px] uppercase ${a.sireType === "proven" ? "text-green-600" : "text-blue-600"}`}>{a.sireType === "proven" ? "P" : "G"}</span>}
                  {a.proofStatus === "inactive" && <span className="ml-0.5 text-[10px] uppercase text-slate-400">inact</span>}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">Tip: the checkbox names combine into <code>?ids=…</code> — bookmark a comparison to reuse it.</p>
          <button type="submit" className="btn-primary mt-2">Compare selected</button>
        </form>
      </Card>

      {prof.length < 1 ? (
        <EmptyState message="Select one or more animals above to build a comparison." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="th sticky left-0 bg-slate-50">Attribute</th>
                  {prof.map((p) => (
                    <th key={p.animal.id} className="th">
                      <Link href={`/animals/${p.animal.id}`} className="link">{p.animal.primaryName}</Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <Row label="Breed" cells={prof.map((p) => p.animal.breed?.breedName ?? "—")} />
                <Row label="Sex" cells={prof.map((p) => SEXES[p.animal.sex as keyof typeof SEXES] ?? p.animal.sex)} />
                <Row label="Status" cells={prof.map((p) => p.animal.currentStatus)} />
                <Row label="Country" cells={prof.map((p) => p.animal.countryOfOrigin ?? "—")} />
                <Row label="Sire role" cells={prof.map((p) => (
                  <SireClassBadges
                    sireType={p.animal.sireType} proofStatus={p.animal.proofStatus}
                    rollbackCount={p.animal.rollbackCount} proofRoundCount={p.animal.proofRoundCount}
                    activityCode={p.animal.latestActivityCode}
                  />
                ))} />
                <Row label="Proof rounds" cells={prof.map((p) => `${p.animal.proofRoundCount}${p.animal.rollbackCount ? ` (${p.animal.rollbackCount} rollback${p.animal.rollbackCount === 1 ? "" : "s"})` : ""}`)} />
                <Row label="Primary ID" cells={prof.map((p) => { const pr = p.animal.identifiers.find((i) => i.isPrimary); return pr ? <span className="font-mono text-xs">{pr.idValue}</span> : "—"; })} />
                <Row label="NAAB" cells={prof.map((p) => p.animal.identifiers.find((i) => i.idType === "naab")?.idValue ?? "—")} />
                <SectionRow label="Preferred proof" span={prof.length + 1} />
                <Row label="Proof run / date" cells={prof.map((p) => p.proof ? (p.proof.proofRun ?? fmtDate(p.proof.evaluationDate)) : "—")} />
                <Row label="Proof source" cells={prof.map((p) => p.proof?.source?.sourceName ?? "—")} />
                {traitRows.map((d) => (
                  <Row key={d.traitCode} label={d.traitName} cells={prof.map((p) => traitVal(p, d.traitCode))} highlight />
                ))}
                <SectionRow label="Classification & production" span={prof.length + 1} />
                <Row label="Classification" cells={prof.map((p) => p.cls ? `${p.cls.classificationCode ?? ""} ${p.cls.finalScore ?? ""}`.trim() || "—" : "—")} />
                <Row label="Class. source" cells={prof.map((p) => p.cls?.source?.sourceName ?? "—")} />
                <Row label="Best milk (kg)" cells={prof.map((p) => p.milk ? fmtNum(p.milk.milkAmount) : "—")} />
                <Row label="Fat / Protein" cells={prof.map((p) => p.milk ? `${fmtNum(p.milk.fatAmount)} / ${fmtNum(p.milk.proteinAmount)}` : "—")} />
                <Row label="Notes" cells={prof.map((p) => <span className="text-xs text-slate-500">{p.animal.notes ?? "—"}</span>)} />
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Row({ label, cells, highlight }: { label: string; cells: React.ReactNode[]; highlight?: boolean }) {
  return (
    <tr className={highlight ? "bg-brand-50/40" : ""}>
      <td className="td sticky left-0 bg-inherit font-medium text-slate-600">{label}</td>
      {cells.map((c, i) => <td key={i} className="td">{c}</td>)}
    </tr>
  );
}

function SectionRow({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <td colSpan={span} className="bg-slate-100 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">{label}</td>
    </tr>
  );
}
