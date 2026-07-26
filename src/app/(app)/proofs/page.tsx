import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { PageHeader, Card, Table, Badge, EmptyState, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { SireRoleField, SireSortField, SireRolePills, SireClassBadges } from "@/components/SireFilters";
import { sireRoleWhere, resolveSort } from "@/lib/sire-class";

export const dynamic = "force-dynamic";

export default async function ProofsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const sp = searchParams;
  const where: Prisma.GeneticEvaluationWhereInput = {};
  if (sp.source) where.sourceId = sp.source;
  if (sp.approval) where.approvalStatus = sp.approval;
  if (sp.preferred === "1") where.isPreferred = true;

  // Animal-side predicates (name search + sire role) share one AND so neither clobbers the other.
  const roleWhere = sireRoleWhere(sp.role) as Prisma.AnimalWhereInput | null;
  const animalAND: Prisma.AnimalWhereInput[] = [];
  if (sp.q) animalAND.push({ primaryName: { contains: sp.q, mode: "insensitive" } });
  if (roleWhere) animalAND.push(roleWhere);
  if (animalAND.length) where.animal = { AND: animalAND };

  // LPI / Conformation live on the evaluation; birth date and name on the animal.
  // Nulls sink to the bottom either way so an unproofed trait never tops the list.
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const sortDef = resolveSort(sp.sort);
  const orderBy: Prisma.GeneticEvaluationOrderByWithRelationInput[] =
    sortDef?.code === "lpi" ? [{ lpi: { sort: dir, nulls: "last" } }]
    : sortDef?.code === "conf" ? [{ conf: { sort: dir, nulls: "last" } }]
    : sortDef?.code === "birth" ? [{ animal: { birthDate: { sort: dir, nulls: "last" } } }]
    : sortDef?.code === "name" ? [{ animal: { primaryName: dir } }]
    : [{ evaluationDate: "desc" }, { createdAt: "desc" }];

  // Pill counts respect every filter except the role axis itself.
  const roleBase: Prisma.GeneticEvaluationWhereInput = {
    ...where,
    ...(sp.q ? { animal: { AND: animalAND.filter((c) => c !== roleWhere) } } : { animal: undefined }),
  };
  const countFor = (r: Prisma.AnimalWhereInput) =>
    prisma.geneticEvaluation.count({ where: { ...roleBase, animal: { AND: [...animalAND.filter((c) => c !== roleWhere), r] } } });

  const [rows, sources, cProven, cGenomic, cActive, cInactive] = await Promise.all([
    prisma.geneticEvaluation.findMany({
      where,
      orderBy,
      take: 200,
      include: { animal: { include: { breed: true } }, source: true },
    }),
    prisma.source.findMany({ orderBy: { sourceName: "asc" } }),
    countFor({ sireType: "proven" }), countFor({ sireType: "genomic" }),
    countFor({ proofStatus: "active" }), countFor({ proofStatus: "inactive" }),
  ]);
  const sortLabel = sortDef && sortDef.code !== "name" ? `sorted by ${sortDef.label} (${dir === "desc" ? "high→low" : "low→high"})` : "most recent first";

  return (
    <div>
      <PageHeader title="Genetic Proofs" subtitle={`${rows.length} evaluation${rows.length === 1 ? "" : "s"} (${sortLabel}, max 200)`} />
      <SireRolePills basePath="/proofs" sp={sp} counts={{ proven: cProven, genomic: cGenomic, active: cActive, inactive: cInactive }} />
      <form method="get" className="card card-pad mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label className="label">Animal name</label>
          <input name="q" defaultValue={sp.q} className="input" placeholder="Search animal…" />
        </div>
        <div>
          <label className="label">Source</label>
          <select name="source" defaultValue={sp.source ?? ""} className="input">
            <option value="">All</option>
            {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Approval</label>
          <select name="approval" defaultValue={sp.approval ?? ""} className="input">
            <option value="">All</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <SireRoleField value={sp.role} />
        <SireSortField sort={sp.sort} dir={sp.dir} />
        <label className="flex items-center gap-1 pb-2 text-xs text-slate-600">
          <input type="checkbox" name="preferred" value="1" defaultChecked={sp.preferred === "1"} /> Preferred only
        </label>
        <button className="btn-primary" type="submit">Filter</button>
        <a href="/proofs" className="btn-secondary">Reset</a>
      </form>

      <Card>
        {rows.length === 0 ? <EmptyState message="No proofs match." /> : (
          <Table head={<><th className="th">Animal</th><th className="th">Breed</th><th className="th">Sire role</th><th className="th">Run / date</th><th className="th">Source</th><th className="th">Key traits</th><th className="th">Rel</th><th className="th">Pref</th><th className="th">Status</th></>}>
            {rows.map((e) => (
              <tr key={e.evaluationId} className="hover:bg-slate-50">
                <td className="td"><Link href={`/animals/${e.animalId}`} className="link font-medium">{e.animal.primaryName}</Link></td>
                <td className="td">{e.animal.breed?.breedName ?? "—"}</td>
                <td className="td"><SireClassBadges sireType={e.animal.sireType} proofStatus={e.animal.proofStatus} activityCode={e.activityCode} showRollbacks={false} /></td>
                <td className="td">{e.proofRun ?? fmtDate(e.evaluationDate)}</td>
                <td className="td text-xs text-slate-500">{e.source?.sourceName ?? "—"}</td>
                <td className="td text-xs">{([["LPI", e.lpi], ["Pro$", e.proDollar], ["Milk", e.milk], ["Fat", e.fat], ["Prot", e.prot]] as const).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</td>
                <td className="td">{e.reliabilityOverall != null ? `${(e.reliabilityOverall * 100).toFixed(0)}%` : "—"}</td>
                <td className="td">{e.isPreferred ? <Badge tone="green">✓</Badge> : ""}</td>
                <td className="td"><Badge tone={statusTone(e.approvalStatus)}>{e.approvalStatus}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
