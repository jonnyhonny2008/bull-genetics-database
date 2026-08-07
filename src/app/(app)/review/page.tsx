import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { CA_ROSTER } from "@/lib/roster-scope";
import { currentUser } from "@/lib/auth";
import { can, REVIEW_STATUSES, RECORD_TYPES, label } from "@/lib/constants";
import { PageHeader, Card, Badge, EmptyState, statusTone } from "@/components/ui";
import AnimalSelect from "@/components/AnimalSelect";
import { fmtDate } from "@/lib/format";
import { isBatchImportType } from "@/lib/constants";
import { approveReview, setReviewStatus, updateReview, approveImport, denyImport, restoreImport } from "./actions";
import { parseManifest, DENY_RETENTION_DAYS, type ImportManifest } from "@/lib/import-staging";

export const dynamic = "force-dynamic";

const ACTIVE = ["pending", "conflict_review", "needs_more_info"];

export default async function ReviewPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) redirect("/dashboard");
  const canApprove = can(user?.role, "record:approve"); // admin — may approve/deny imports

  const filter = searchParams.status;
  const where = filter ? { status: filter } : { status: { in: ACTIVE } };

  const [items, counts] = await Promise.all([
    prisma.importReviewQueue.findMany({
      where, orderBy: { createdAt: "desc" },
      include: { capture: { include: { source: true } }, matchedAnimal: true },
    }),
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
          {items.map((r) => {
            // Batch imports (Proof Import / large Animal Import) carry a manifest
            // and get an approve/deny card instead of the per-record editor. Gate on
            // the AUTHORITATIVE proposedRecordType (only createImportReview sets it),
            // never on parseManifest alone — a forged upload could otherwise put a
            // manifest in a non-batch row and get admin Approve/Deny controls.
            const manifest = isBatchImportType(r.proposedRecordType) ? parseManifest(r.extractedDataJson) : null;
            if (manifest) return <ImportBatchCard key={r.reviewId} r={r} manifest={manifest} canApprove={canApprove} />;
            return (
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
                    {/* Was a <select> holding all 99,784 animals, repeated once
                        PER QUEUE ITEM on this page. The current match is passed
                        as `initial` so an already-matched item still shows its
                        animal without the roster being shipped to find it. */}
                    <AnimalSelect
                      name="matchedAnimalId"
                      initial={r.matchedAnimal && !r.matchedAnimal.archived
                        ? { id: r.matchedAnimal.id, name: r.matchedAnimal.primaryName }
                        : null}
                      emptyLabel="Leave empty for none (create new / unmatched)"
                    />
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
            );
          })}
        </div>
      )}
    </div>
  );
}

function ImportBatchCard({
  r,
  manifest,
  canApprove,
}: {
  r: { reviewId: string; status: string; createdAt: Date; reviewedAt: Date | null };
  manifest: ImportManifest;
  canApprove: boolean;
}) {
  const isMass = manifest.mode === "all";
  const createdCount = manifest.animals.filter((a) => a.created).length;
  const shown = manifest.animals.slice(0, 12);
  const rest = manifest.animals.length - shown.length;
  const pending = r.status === "pending";
  const rejected = r.status === "rejected";
  const purgeAt = rejected && r.reviewedAt ? new Date(r.reviewedAt.getTime() + DENY_RETENTION_DAYS * 86_400_000) : null;
  const withinWindow = purgeAt ? purgeAt.getTime() > Date.now() : false;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(r.status)}>{r.status}</Badge>
        <Badge tone="brand">{manifest.kind === "proof" ? "Proof import" : "Animal import"}</Badge>
        <span className="text-sm text-slate-700">{manifest.label}</span>
        <span className="ml-auto text-xs text-slate-400">{fmtDate(r.createdAt)}</span>
      </div>

      {isMass ? (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Nothing has been imported yet. Approving starts the background import of every bull in the file; denying discards the request.
        </p>
      ) : (
        <p className="mb-3 text-sm text-slate-600">
          <span className="font-semibold">{manifest.animals.length}</span> animal{manifest.animals.length === 1 ? "" : "s"} written as{" "}
          <span className="font-semibold text-amber-700">pending</span>
          {createdCount > 0 && <> · <span className="font-semibold">{createdCount}</span> newly created</>}.{" "}
          Approving makes them authoritative; denying archives the new animals and rejects the evaluations — restorable for {DENY_RETENTION_DAYS} days, then permanently deleted.
        </p>
      )}

      {!isMass && manifest.animals.length > 0 && (
        <ul className="mb-3 max-h-56 space-y-1 overflow-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          {shown.map((a) => (
            <li key={a.animalId} className="flex items-center justify-between gap-2">
              <span className="truncate">
                <Link className="link font-medium" href={`/animals/${a.animalId}`}>{a.name ?? a.reg}</Link>{" "}
                <span className="font-mono text-slate-400">{a.reg}</span>
              </span>
              <Badge tone={a.created ? "green" : "amber"}>{a.created ? "new" : "updated"}</Badge>
            </li>
          ))}
          {rest > 0 && <li className="text-slate-400">+{rest} more…</li>}
        </ul>
      )}

      {pending ? (
        canApprove ? (
          <div className="flex flex-wrap gap-2">
            <form action={approveImport}>
              <input type="hidden" name="reviewId" value={r.reviewId} />
              <button className="btn-primary btn-sm" type="submit">{isMass ? "Approve & start import" : "Approve import"}</button>
            </form>
            <form action={denyImport}>
              <input type="hidden" name="reviewId" value={r.reviewId} />
              <button className="btn-danger btn-sm" type="submit">{isMass ? "Deny request" : "Deny"}</button>
            </form>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Awaiting an admin’s approval — you don’t have permission to approve imports.</p>
        )
      ) : rejected ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">
            Denied{r.reviewedAt ? ` ${fmtDate(r.reviewedAt)}` : ""}.
            {isMass
              ? " Nothing was imported."
              : withinWindow && purgeAt
                ? ` Archived — permanently deleted on ${fmtDate(purgeAt)}.`
                : " Past the restore window."}
          </span>
          {!isMass && canApprove && withinWindow && (
            <form action={restoreImport}>
              <input type="hidden" name="reviewId" value={r.reviewId} />
              <button className="btn-secondary btn-sm" type="submit">↩ Restore</button>
            </form>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">This import was already {r.status}.</p>
      )}
    </Card>
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
