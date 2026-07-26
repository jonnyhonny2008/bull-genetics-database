import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { PageHeader, Card, Table, Badge, EmptyState, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { SireRoleField, SireSortField, SireRolePills, SireClassBadges } from "@/components/SireFilters";
import { sireRoleWhere, resolveSort } from "@/lib/sire-class";
import { rankAnimalsByEvalColumn } from "@/lib/sire-rank";

export const dynamic = "force-dynamic";

const MAX_ROWS = 200;

export default async function ClassificationPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const sp = searchParams;
  const where: Prisma.ClassificationRecordWhereInput = {};
  if (sp.source) where.sourceId = sp.source;
  if (sp.preferred === "1") where.isPreferred = true;
  if (sp.min && !isNaN(Number(sp.min))) where.finalScore = { gte: Number(sp.min) };

  const roleWhere = sireRoleWhere(sp.role) as Prisma.AnimalWhereInput | null;
  const animalAND: Prisma.AnimalWhereInput[] = [];
  if (sp.q) animalAND.push({ primaryName: { contains: sp.q, mode: "insensitive" } });
  if (roleWhere) animalAND.push(roleWhere);
  if (animalAND.length) where.animal = { AND: animalAND };

  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const sortDef = resolveSort(sp.sort);
  // Same reason as the milk list: LPI / Conformation live on the animal's
  // preferred evaluation, so rank the animals first and reorder in memory.
  const rank = sortDef?.kind === "eval"
    ? await rankAnimalsByEvalColumn(sortDef.col as "lpi" | "conf", dir, animalAND)
    : null;
  if (rank) where.animalId = { in: [...rank.keys()] };
  const orderBy: Prisma.ClassificationRecordOrderByWithRelationInput =
    sortDef?.code === "birth" ? { animal: { birthDate: { sort: dir, nulls: "last" } } }
    : sortDef?.code === "name" ? { animal: { primaryName: dir } }
    : { classificationDate: "desc" };

  const countFor = (r: Prisma.AnimalWhereInput) =>
    prisma.classificationRecord.count({ where: { ...where, animalId: undefined, animal: { AND: [...animalAND.filter((c) => c !== roleWhere), r] } } });

  const [fetched, sources, cProven, cGenomic, cActive, cInactive] = await Promise.all([
    prisma.classificationRecord.findMany({ where, orderBy, take: rank ? 1000 : MAX_ROWS, include: { animal: { include: { breed: true } }, source: true } }),
    prisma.source.findMany({ orderBy: { sourceName: "asc" } }),
    countFor({ sireType: "proven" }), countFor({ sireType: "genomic" }),
    countFor({ proofStatus: "active" }), countFor({ proofStatus: "inactive" }),
  ]);
  const rows = rank
    ? [...fetched].sort((a, b) => (rank.get(a.animalId) ?? 1e9) - (rank.get(b.animalId) ?? 1e9)).slice(0, MAX_ROWS)
    : fetched;
  const sortLabel = sortDef && sortDef.code !== "name" ? `sorted by ${sortDef.label} (${dir === "desc" ? "high→low" : "low→high"})` : "most recent first";

  return (
    <div>
      <PageHeader title="Classification" subtitle={`${rows.length} record${rows.length === 1 ? "" : "s"} (${sortLabel}, max ${MAX_ROWS})`} />
      <SireRolePills basePath="/classification" sp={sp} counts={{ proven: cProven, genomic: cGenomic, active: cActive, inactive: cInactive }} />
      <form method="get" className="card card-pad mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
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
          <label className="label">Final score ≥</label>
          <input name="min" defaultValue={sp.min} className="input w-24" placeholder="85" />
        </div>
        <SireRoleField value={sp.role} />
        <SireSortField sort={sp.sort} dir={sp.dir} />
        <label className="flex items-center gap-1 pb-2 text-xs text-slate-600">
          <input type="checkbox" name="preferred" value="1" defaultChecked={sp.preferred === "1"} /> Preferred only
        </label>
        <button className="btn-primary" type="submit">Filter</button>
        <a href="/classification" className="btn-secondary">Reset</a>
      </form>

      <Card>
        {rows.length === 0 ? <EmptyState message="No classification records match." /> : (
          <Table head={<><th className="th">Animal</th><th className="th">Sire role</th><th className="th">Date</th><th className="th">Code</th><th className="th">Final</th><th className="th">Lact</th><th className="th">Source</th><th className="th">Pref</th><th className="th">Status</th></>}>
            {rows.map((c) => (
              <tr key={c.classificationId} className="hover:bg-slate-50">
                <td className="td"><Link href={`/animals/${c.animalId}`} className="link font-medium">{c.animal.primaryName}</Link></td>
                <td className="td"><SireClassBadges sireType={c.animal.sireType} proofStatus={c.animal.proofStatus} activityCode={c.animal.latestActivityCode} showRollbacks={false} /></td>
                <td className="td">{fmtDate(c.classificationDate)}</td>
                <td className="td">{c.classificationCode ?? "—"}</td>
                <td className="td font-medium">{c.finalScore ?? "—"}</td>
                <td className="td">{c.lactationNumber ?? "—"}</td>
                <td className="td text-xs text-slate-500">{c.source?.sourceName ?? "—"}</td>
                <td className="td">{c.isPreferred ? <Badge tone="green">✓</Badge> : ""}</td>
                <td className="td"><Badge tone={statusTone(c.approvalStatus)}>{c.approvalStatus}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
