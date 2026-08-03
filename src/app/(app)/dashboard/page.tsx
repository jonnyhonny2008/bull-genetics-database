import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatCard, Card, Table, Badge, EmptyState } from "@/components/ui";
import { fmtDate, fmtNum, relTime } from "@/lib/format";
import { SIRE_ROLES } from "@/lib/sire-class";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // All aggregates run at the DB level so the dashboard stays fast at ~100k animals.
  const [
    totalAnimals,
    breeds,
    byBreedRaw,
    bySireClassRaw,
    recentProofs,
    recentMilk,
    recentClass,
    pendingReviews,
    recentCaptures,
    missingPrimary,
    dupRows,
    pendingProofs,
    pendingMilk,
    pendingClass,
    totalRounds,
  ] = await Promise.all([
    prisma.animal.count({ where: { archived: false } }),
    prisma.breed.findMany(),
    prisma.animal.groupBy({ by: ["breedId"], where: { archived: false }, _count: true }),
    prisma.animal.groupBy({ by: ["sireType", "proofStatus"], where: { archived: false }, _count: true }),
    prisma.geneticEvaluation.findMany({ where: { animal: { archived: false } }, take: 5, orderBy: { createdAt: "desc" }, include: { animal: true, source: true } }),
    prisma.milkRecord.findMany({ where: { animal: { archived: false } }, take: 5, orderBy: { createdAt: "desc" }, include: { animal: true, source: true } }),
    prisma.classificationRecord.findMany({ where: { animal: { archived: false } }, take: 5, orderBy: { createdAt: "desc" }, include: { animal: true, source: true } }),
    prisma.importReviewQueue.findMany({ where: { status: { in: ["pending", "conflict_review", "needs_more_info"] } }, include: { capture: { include: { source: true } }, matchedAnimal: true } }),
    prisma.sourceCapture.findMany({ where: { OR: [{ animalId: null }, { animal: { archived: false } }] }, take: 5, orderBy: { capturedAt: "desc" }, include: { source: true, animal: true } }),
    prisma.animal.count({ where: { archived: false, identifiers: { none: { isPrimary: true, active: true } } } }),
    prisma.animalIdentifier.groupBy({ by: ["idValue"], where: { idType: { in: ["registration_ca", "registration_us", "registration_int", "naab", "semen_code"] } }, _count: { idValue: true }, having: { idValue: { _count: { gt: 1 } } } }),
    prisma.geneticEvaluation.count({ where: { approvalStatus: "pending" } }),
    prisma.milkRecord.count({ where: { approvalStatus: "pending" } }),
    prisma.classificationRecord.count({ where: { approvalStatus: "pending" } }),
    prisma.geneticEvaluation.count(),
  ]);

  const breedName = new Map(breeds.map((b) => [b.breedId, b.breedName]));
  const byBreed = new Map<string, number>();
  for (const g of byBreedRaw) byBreed.set(g.breedId ? breedName.get(g.breedId) ?? "Unknown" : "No breed", g._count);
  // proven/genomic and active/inactive are two independent axes of the same
  // groupBy, so each row contributes to one bar on each axis.
  const bySireClass = new Map<string, number>(SIRE_ROLES.map((r) => [r.code, 0]));
  for (const g of bySireClassRaw) {
    const add = (k: string | null) => { if (k && bySireClass.has(k)) bySireClass.set(k, (bySireClass.get(k) ?? 0) + g._count); };
    add(g.sireType); add(g.proofStatus);
  }
  const unclassified = totalAnimals - ((bySireClass.get("active") ?? 0) + (bySireClass.get("inactive") ?? 0));

  const duplicateCount = dupRows.length;
  const needingApproval = pendingProofs + pendingMilk + pendingClass;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Historical Genetic Proof Database"
        actions={<Link href="/animals/new" className="btn-primary">+ New animal</Link>}
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total animals" value={fmtNum(totalAnimals)} href="/animals" tone="good" />
        <StatCard label="Proof rounds" value={fmtNum(totalRounds)} href="/analysis" tone="accent" />
        <StatCard label="Pending review" value={pendingReviews.length} href="/review" tone={pendingReviews.length ? "warn" : "default"} />
        <StatCard label="Needs approval" value={needingApproval} tone={needingApproval ? "warn" : "default"} />
        <StatCard label="Missing primary ID" value={fmtNum(missingPrimary)} tone={missingPrimary ? "warn" : "default"} />
        <StatCard label="Possible duplicates" value={fmtNum(duplicateCount)} href="/admin/data-quality" tone={duplicateCount ? "danger" : "default"} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Animals by breed">
          {byBreed.size === 0 ? (
            <EmptyState message="No animals yet." />
          ) : (
            <div className="space-y-2">
              {[...byBreed.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => (
                <BarRow key={name} label={name} value={n} max={Math.max(...byBreed.values())} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Sires by role">
          {totalAnimals === 0 ? (
            <EmptyState message="No animals yet." />
          ) : (
            <>
              <div className="space-y-2">
                {SIRE_ROLES.map((r) => (
                  <BarRow
                    key={r.code}
                    label={r.label}
                    value={bySireClass.get(r.code) ?? 0}
                    max={Math.max(1, ...bySireClass.values())}
                    href={`/animals?role=${r.code}`}
                    barClass="bg-accent-500"
                  />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Proven / genomic and active / inactive are separate axes, so each sire appears in two bars.
                {unclassified > 0 && ` ${fmtNum(unclassified)} not yet classified (no approved proof).`}
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Recent genetic proofs">
          <RecentList
            rows={recentProofs.map((p) => ({ id: p.evaluationId, href: `/animals/${p.animalId}`, name: p.animal.primaryName, meta: `${p.proofRun ?? fmtDate(p.evaluationDate)} · ${p.source?.sourceName ?? "—"}`, when: p.createdAt }))}
            empty="No proofs yet."
          />
        </Card>
        <Card title="Recent milk records">
          <RecentList
            rows={recentMilk.map((m) => ({ id: m.milkRecordId, href: `/animals/${m.animalId}`, name: m.animal.primaryName, meta: `Lact ${m.lactationNumber ?? "—"} · ${m.milkAmount ?? "—"}kg · ${m.source?.sourceName ?? "—"}`, when: m.createdAt }))}
            empty="No milk records yet."
          />
        </Card>
        <Card title="Recent classifications">
          <RecentList
            rows={recentClass.map((c) => ({ id: c.classificationId, href: `/animals/${c.animalId}`, name: c.animal.primaryName, meta: `${c.classificationCode ?? "—"} ${c.finalScore ?? ""} · ${c.source?.sourceName ?? "—"}`, when: c.createdAt }))}
            empty="No classification records yet."
          />
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Pending review items" actions={<Link href="/review" className="link text-xs">Open queue →</Link>}>
          {pendingReviews.length === 0 ? (
            <EmptyState message="Review queue is clear." />
          ) : (
            <Table head={<><th className="th">Source</th><th className="th">Proposed</th><th className="th">Matched animal</th><th className="th">Status</th></>}>
              {pendingReviews.slice(0, 6).map((r) => (
                <tr key={r.reviewId}>
                  <td className="td">{r.capture.source?.sourceName ?? "—"}</td>
                  <td className="td">{r.proposedRecordType}</td>
                  <td className="td">{r.matchedAnimal && !r.matchedAnimal.archived ? <Link className="link" href={`/animals/${r.matchedAnimalId}`}>{r.matchedAnimal.primaryName}</Link> : <span className="text-slate-400">{r.matchedAnimal ? "unmatched" : "new animal"}</span>}</td>
                  <td className="td"><Badge tone={r.status === "conflict_review" ? "red" : "amber"}>{r.status}</Badge></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Recent uploads / captures" actions={<Link href="/uploads" className="link text-xs">Upload center →</Link>}>
          {recentCaptures.length === 0 ? (
            <EmptyState message="No uploads yet." />
          ) : (
            <Table head={<><th className="th">File</th><th className="th">Source</th><th className="th">Animal</th><th className="th">When</th></>}>
              {recentCaptures.map((c) => (
                <tr key={c.captureId}>
                  <td className="td">{c.originalFileName ?? c.captureType}</td>
                  <td className="td">{c.source?.sourceName ?? "—"}</td>
                  <td className="td">{c.animal ? <Link className="link" href={`/animals/${c.animalId}`}>{c.animal.primaryName}</Link> : "—"}</td>
                  <td className="td text-slate-400">{relTime(c.capturedAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function BarRow({ label, value, max, href, barClass = "bg-brand-500" }: { label: string; value: number; max: number; href?: string; barClass?: string }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs">
        {href
          ? <Link href={href} className="font-medium text-slate-700 hover:text-brand-700 hover:underline">{label}</Link>
          : <span className="font-medium text-slate-700">{label}</span>}
        <span className="text-slate-500">{value}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100">
        <div className={`h-2 rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RecentList({ rows, empty }: { rows: { id: string; href: string; name: string; meta: string; when: Date }[]; empty: string }) {
  if (rows.length === 0) return <EmptyState message={empty} />;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.id} className="py-2">
          <Link href={r.href} className="link text-sm font-medium">{r.name}</Link>
          <div className="flex justify-between text-xs text-slate-500">
            <span>{r.meta}</span>
            <span className="text-slate-400">{relTime(r.when)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
