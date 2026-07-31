import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getAllSources } from "@/lib/reference";
import { currentUser } from "@/lib/auth";
import { can, CAPTURE_TYPES, RECORD_TYPES } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { uploadCapture } from "./actions";

export const dynamic = "force-dynamic";

const EXAMPLE = JSON.stringify(
  { animal: "MAPLE-CREST THUNDER", proofRun: "August 2026", evaluationDate: "2026-08-01", traits: { LPI: 3555, "PRO$": 2810, MILK: 1560, FAT: 90, PROT: 66 } },
  null, 2,
);

export default async function UploadsPage() {
  const user = currentUser();
  if (!can(user?.role, "upload:write")) redirect("/dashboard");

  const [sources, animals, captures] = await Promise.all([
    getAllSources(),
    prisma.animal.findMany({ where: { archived: false }, orderBy: { primaryName: "asc" }, select: { id: true, primaryName: true } }),
    prisma.sourceCapture.findMany({ where: { OR: [{ animalId: null }, { animal: { archived: false } }] }, orderBy: { capturedAt: "desc" }, take: 25, include: { source: true, animal: true, reviewItems: true } }),
  ]);

  return (
    <div>
      <PageHeader title="Upload Center" subtitle="Upload official reports, catalogues, CSVs, or screenshots. Each upload becomes a traceable source capture and a review-queue item." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="New upload / capture">
          <form action={uploadCapture} className="space-y-3" encType="multipart/form-data">
            <div>
              <label className="label">File (CSV / Excel / PDF / image / report)</label>
              <input type="file" name="file" className="input" accept=".csv,.xls,.xlsx,.pdf,.png,.jpg,.jpeg,.txt" />
              <p className="mt-1 text-[11px] text-slate-400">Optional — you can also record a browser-assisted lookup or manual capture with no file.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Source</label>
                <select name="sourceId" className="input" defaultValue="">
                  <option value="">— none —</option>
                  {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Capture type</label>
                <select name="captureType" className="input" defaultValue="pdf">
                  {CAPTURE_TYPES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Proposed record type</label>
                <select name="proposedRecordType" className="input" defaultValue="genetic_evaluation">
                  {RECORD_TYPES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Link to animal (optional)</label>
                <select name="animalId" className="input" defaultValue="">
                  <option value="">— auto-match in review —</option>
                  {animals.map((a) => <option key={a.id} value={a.id}>{a.primaryName}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label">Source URL (optional)</label>
              <input name="sourceUrl" className="input" placeholder="https://…" />
            </div>
            <div>
              <label className="label">Extracted data (JSON) — simulated extraction</label>
              <textarea name="extractedDataJson" rows={7} className="input font-mono text-xs" defaultValue={EXAMPLE} />
              <p className="mt-1 text-[11px] text-slate-400">Full AI extraction is a Phase-1 placeholder. Paste/adjust the JSON that would be extracted; it flows into the review queue for approval.</p>
            </div>
            <div>
              <label className="label">Notes</label>
              <input name="notes" className="input" />
            </div>
            <button type="submit" className="btn-primary">Upload & create review item</button>
          </form>
        </Card>

        <Card title="Recent captures" actions={<Link href="/review" className="link text-xs">Review queue →</Link>}>
          {captures.length === 0 ? <EmptyState message="No captures yet." /> : (
            <Table head={<><th className="th">When</th><th className="th">File / URL</th><th className="th">Source</th><th className="th">Animal</th><th className="th">Review</th></>}>
              {captures.map((c) => (
                <tr key={c.captureId}>
                  <td className="td">{fmtDate(c.capturedAt)}</td>
                  <td className="td text-xs">{c.originalFileName ?? c.sourceUrl ?? c.captureType}</td>
                  <td className="td text-xs text-slate-500">{c.source?.sourceName ?? "—"}</td>
                  <td className="td text-xs">{c.animal ? <Link className="link" href={`/animals/${c.animalId}`}>{c.animal.primaryName}</Link> : "—"}</td>
                  <td className="td">{c.reviewItems[0] ? <Badge tone={c.reviewItems[0].status === "approved" ? "green" : "amber"}>{c.reviewItems[0].status}</Badge> : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
