import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, EmptyState, Badge } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { listProofFiles, importsDir } from "@/lib/lactanet";
import { importByReg, importBulk } from "./actions";
import MassImport from "./MassImport";

export const dynamic = "force-dynamic";

export default async function ImportProofsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) redirect("/dashboard");

  const files = listProofFiles();
  const totalAnimals = await prisma.animal.count({ where: { archived: false } });

  return (
    <div>
      <PageHeader
        title="Bull Proof Import"
        subtitle="Import genomics, indexes, production, functional traits, linear conformation, and pedigree from the official Lactanet bull-proof CSV. Every import is sent to the review queue for an admin to approve before it becomes an animal's official proof."
      />

      {searchParams.uploaded && (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Uploaded <span className="font-mono">{searchParams.uploaded}</span> to the imports folder. Choose it below and import.</div>
      )}
      {searchParams.queued && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {searchParams.queued === "all"
            ? <>Mass import request sent for approval. Nothing is imported until an admin approves it in the </>
            : <><span className="font-semibold">{searchParams.queued}</span> bull(s) imported as <span className="font-semibold">pending</span> and sent for approval — they stay pending until an admin approves them in the </>}
          <a href="/review" className="font-medium underline">review queue</a>.
        </div>
      )}

      {/* Browser-chunked mass import — works on Vercel, no server file needed. */}
      <Card title="Mass import — ALL bulls" className="mb-4 border-brand-300">
        <MassImport />
      </Card>

      {/* Upload from your computer (for the single/top-N imports below, which read
          a server-side file — available on the local/self-hosted server). */}
      <Card title="Upload a proof file from your computer" className="mb-4">
        <form action="/api/proof-upload" method="post" encType="multipart/form-data" className="flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label className="label">Lactanet CSV (e.g. aiobgepa2604_ho.csv — up to ~100 MB)</label>
            <input type="file" name="file" accept=".csv" required className="input" />
          </div>
          <button type="submit" className="btn-primary">Upload</button>
        </form>
        <p className="mt-2 text-[11px] text-slate-400">The file is stored server-side in <code>{importsDir()}</code>, then available below to import. Current animals in database: <span className="font-semibold">{fmtNum(totalAnimals)}</span>.</p>
      </Card>

      {files.length === 0 ? (
        <Card title="No proof files found">
          <EmptyState message="Upload a Lactanet proof CSV above (or drop one into the imports folder), then reload.">
            <code className="rounded bg-slate-100 px-2 py-1 text-xs">{importsDir()}</code>
          </EmptyState>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Import one bull by Reg # or NAAB code">
            <form action={importByReg} className="space-y-3">
              <div>
                <label className="label">Proof file</label>
                <select name="fileName" className="input">
                  {files.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.sizeMB} MB)</option>)}
                </select>
              </div>
              <div>
                <label className="label">Registration number or NAAB code</label>
                <input name="query" className="input" placeholder="e.g. HO840M3125993715 or 551HO03379" required />
              </div>
              <button type="submit" className="btn-primary">Look up & send for approval</button>
              <p className="text-[11px] text-slate-400">Imports one animal (full genomic evaluation + identifiers + pedigree) as <span className="font-medium">pending</span>, then sends it to the review queue. Source: LactanetGen.</p>
            </form>
          </Card>

          <Card title="Bulk import (top N by index)">
            <form action={importBulk} className="space-y-3">
              <div>
                <label className="label">Proof file</label>
                <select name="fileName" className="input">
                  {files.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.sizeMB} MB)</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Rank by</label>
                  <select name="sortCol" className="input" defaultValue="LPI">
                    <option value="LPI">LPI</option>
                    <option value="PRO$">Pro$</option>
                    <option value="LONGEVITY & TYPE INDEX (LTI)">LTI</option>
                    <option value="HEALTH & WELFARE INDEX (HWI)">HWI</option>
                  </select>
                </div>
                <div>
                  <label className="label">How many (max 200)</label>
                  <input name="limit" type="number" min="1" max="200" defaultValue={10} className="input" />
                </div>
              </div>
              <button type="submit" className="btn-secondary">Send top N for approval</button>
              <p className="text-[11px] text-slate-400">Handy for a small working set. Imported as pending and sent to the review queue. For the whole file, use “Send ALL bulls” above.</p>
            </form>
          </Card>

          <Card title="Available files" className="lg:col-span-2">
            <ul className="space-y-1 text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-2">
                  <Badge tone="brand">CSV</Badge>
                  <span className="font-mono text-xs">{f.name}</span>
                  <span className="text-slate-400">{f.sizeMB} MB</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
