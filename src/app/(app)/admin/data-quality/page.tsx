import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { findDuplicateGroups } from "@/lib/quality";

export const dynamic = "force-dynamic";

export default async function DataQualityPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");

  // Counts + capped samples run at the DB level (scales to ~100k animals).
  const noPrimary = { archived: false, identifiers: { none: { isPrimary: true, active: true } } } as const;
  const noProofW = { archived: false, evaluations: { none: {} } } as const;
  const femNoMilkW = { archived: false, sex: "F", milkRecords: { none: {} } } as const;
  const [missingBreedCount, missingPrimaryCount, noProofCount, femalesNoMilkCount, dupes, missingBreedS, missingPrimaryS, femalesNoMilkS] = await Promise.all([
    prisma.animal.count({ where: { archived: false, breedId: null } }),
    prisma.animal.count({ where: noPrimary }),
    prisma.animal.count({ where: noProofW }),
    prisma.animal.count({ where: femNoMilkW }),
    findDuplicateGroups(),
    prisma.animal.findMany({ where: { archived: false, breedId: null }, select: { id: true, primaryName: true }, take: 12 }),
    prisma.animal.findMany({ where: noPrimary, select: { id: true, primaryName: true }, take: 12 }),
    prisma.animal.findMany({ where: femNoMilkW, select: { id: true, primaryName: true }, take: 12 }),
  ]);

  return (
    <div>
      <PageHeader title="Data Quality & Duplicates" subtitle="Automated indicators to keep the database clean. Nothing here is deleted automatically." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniStat label="Missing breed" value={missingBreedCount} />
        <MiniStat label="Missing primary ID" value={missingPrimaryCount} />
        <MiniStat label="No genetic proof" value={noProofCount} />
        <MiniStat label="Possible duplicate groups" value={dupes.length} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Possible duplicates">
          {dupes.length === 0 ? <EmptyState message="No possible duplicates detected." /> : (
            <ul className="space-y-2">
              {dupes.map((g, i) => (
                <li key={i} className="rounded-md border border-slate-200 p-2">
                  <div className="mb-1 text-xs font-semibold text-purple-700">{g.reason}</div>
                  <div className="flex flex-wrap gap-2">
                    {g.animals.map((a) => <Link key={a.id} href={`/animals/${a.id}`} className="link text-sm">{a.primaryName} <span className="text-xs text-slate-400">{a.breedName ?? ""}</span></Link>)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Records needing attention">
          <QualityList title="Missing breed" count={missingBreedCount} animals={missingBreedS} />
          <QualityList title="Missing primary identifier" count={missingPrimaryCount} animals={missingPrimaryS} />
          <QualityList title="Females with no milk record" count={femalesNoMilkCount} animals={femalesNoMilkS} />
        </Card>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card card-pad">
      <div className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-slate-500 break-words">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${value ? "text-amber-600" : "text-slate-800"}`}>{value}</div>
    </div>
  );
}

function QualityList({ title, count, animals }: { title: string; count: number; animals: { id: string; primaryName: string }[] }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title} ({count.toLocaleString()})</div>
      {count === 0 ? <div className="text-xs text-emerald-700">✓ none</div> : (
        <div className="flex flex-wrap gap-2">
          {animals.map((a) => <Link key={a.id} href={`/animals/${a.id}`} className="link text-sm">{a.primaryName}</Link>)}
          {count > animals.length && <span className="text-xs text-slate-400">+{(count - animals.length).toLocaleString()} more</span>}
        </div>
      )}
    </div>
  );
}
