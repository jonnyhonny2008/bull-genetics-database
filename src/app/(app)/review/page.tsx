import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, REVIEW_STATUSES, RECORD_TYPES, label } from "@/lib/constants";
import { PageHeader, Card, Badge, EmptyState, statusTone } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { approveReview, setReviewStatus, updateReview } from "./actions";

export const dynamic = "force-dynamic";

const ACTIVE = ["pending", "conflict_review", "needs_more_info"];

export default async function ReviewPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) redirect("/dashboard");

  const filter = searchParams.status;
  const where = filter ? { status: filter } : { status: { in: ACTIVE } };

  const [items, animals, counts] = await Promise.all([
    prisma.importReviewQueue.findMany({
      where, orderBy: { createdAt: "desc" },
      include: { capture: { include: { source: true } }, matchedAnimal: true },
    }),
    prisma.animal.findMany({ where: { archived: false }, orderBy: { primaryName: "asc" }, select: { id: true, primaryName: true } }),
    prisma.importReviewQueue.groupBy({ by: ["status"], _count: true }),
  ]);
  const countByStatus = new Map(counts.map((c) => [c.status, c._count]));

  return (
    <div>
      <PageHeader title="Import Review Queue" subtitle="Review extracted data, match to an animal, then approve to create real records linked to source history." />

      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <FilterChip href="/review" active={!filter} label={`Active (${ACTIVE.reduce((n, s) => n + (countByStatus.get(s) ?? 0), 0)})`} />
        {REVIEW_STATUSES.map((s) => (
          <FilterChip key={s.code} href={`/review?status=${s.code}`} active={filter === s.code} label={`${s.label} (${countByStatus.get(s.code) ?? 0})`} />
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState message="No review items in this view." />
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <Card key={r.reviewId}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                <span className="text-sm font-semibold">{label(RECORD_TYPES, r.proposedRecordType)}</span>
                <span className="text-slate-400">·</span>
                <span className="text-sm text-slate-600">{r.capture.source?.sourceName ?? "no source"}</span>
                <span className="text-slate-400">·</span>
                <span className="text-xs text-slate-500">{r.capture.originalFileName ?? r.capture.sourceUrl ?? r.capture.captureType}</span>
                {r.matchConfidence != null && <Badge tone={r.matchConfidence > 0.8 ? "green" : "amber"}>match {Math.round(r.matchConfidence * 100)}%</Badge>}
                <span className="ml-auto text-xs text-slate-400">{fmtDate(r.createdAt)}</span>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Edit form */}
                <form action={updateReview} className="space-y-2">
                  <input type="hidden" name="reviewId" value={r.reviewId} />
                  <div>
                    <label className="label">Matched animal</label>
                    <select name="matchedAnimalId" defaultValue={r.matchedAnimalId ?? ""} className="input">
                      <option value="">— none (create new / unmatched) —</option>
                      {animals.map((a) => <option key={a.id} value={a.id}>{a.primaryName}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Extracted data (JSON)</label>
                    <textarea name="extractedDataJson" rows={7} defaultValue={r.extractedDataJson ?? ""} className="input font-mono text-xs" />
                  </div>
                  <div>
                    <label className="label">Review notes</label>
                    <input name="reviewNotes" defaultValue={r.reviewNotes ?? ""} className="input" />
                  </div>
                  <button type="submit" className="btn-secondary btn-sm">Save edits</button>
                </form>

                {/* Decision panel */}
                <div className="space-y-3">
                  <div className="rounded-md border border-slate-200 p-3 text-sm">
                    <div className="mb-1 font-semibold text-slate-700">Capture details</div>
                    <div className="text-slate-600">Type: {r.capture.captureType}</div>
                    <div className="text-slate-600">Extraction: {r.capture.extractionStatus}</div>
                    {r.capture.storedFileUrl && <div className="break-all text-xs text-slate-400">File: {r.capture.storedFileUrl}</div>}
                    {r.capture.notes && <div className="mt-1 text-xs text-slate-500">{r.capture.notes}</div>}
                    {r.matchedAnimal && !r.matchedAnimal.archived && <div className="mt-1">Currently linked: <Link className="link" href={`/animals/${r.matchedAnimalId}`}>{r.matchedAnimal.primaryName}</Link></div>}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <form action={approveReview}>
                      <input type="hidden" name="reviewId" value={r.reviewId} />
                      <button className="btn-primary btn-sm" type="submit">Approve → create record</button>
                    </form>
                    <StatusButton reviewId={r.reviewId} status="rejected" label="Reject" tone="danger" />
                    <StatusButton reviewId={r.reviewId} status="duplicate" label="Mark duplicate" />
                    <StatusButton reviewId={r.reviewId} status="needs_more_info" label="Needs info" />
                    <StatusButton reviewId={r.reviewId} status="conflict_review" label="Conflict" />
                    <StatusButton reviewId={r.reviewId} status="pending" label="Reopen" />
                  </div>
                  <p className="text-[11px] text-slate-400">Approving a proof / milk / classification requires a matched animal. Approving an “animal” item creates a new animal from the JSON.</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link href={href} className={`rounded-full px-3 py-1 ${active ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`}>
      {label}
    </Link>
  );
}

function StatusButton({ reviewId, status, label, tone = "secondary" }: { reviewId: string; status: string; label: string; tone?: "secondary" | "danger" }) {
  return (
    <form action={setReviewStatus}>
      <input type="hidden" name="reviewId" value={reviewId} />
      <input type="hidden" name="status" value={status} />
      <button className={`${tone === "danger" ? "btn-danger" : "btn-secondary"} btn-sm`} type="submit">{label}</button>
    </form>
  );
}
