import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, EmptyState, Badge } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { listProofFiles, importsDir } from "@/lib/lactanet";
import { importByReg, importBulk, startBulkImport } from "./actions";

export const dynamic = "force-dynamic";

export default async function ImportProofsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) redirect("/dashboard");

  const files = listProofFiles();
  const totalAnimals = await prisma.animal.count();

  return (
    <div>
      <PageHeader
        title="Bull Proof Import"
        subtitle="Import genomics, indexes, production, functional traits, linear conformation, and pedigree from the official Lactanet bull-proof CSV."
      />

      {searchParams.uploaded && (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Uploaded <span className="font-mono">{searchParams.uploaded}</span> to the imports folder. Choose it below and import.</div>
      )}
      {searchParams.started && (
        <div className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">Mass import started in the background. It processes ~99,000 bulls in ~8–10 minutes — refresh this page (or the Animals list) to watch the count grow. Already-imported bulls are skipped.</div>
      )}

      {/* Upload from your computer */}
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
          {/* Mass import — everything */}
          <Card title="Mass import — ALL bulls in a file" className="lg:col-span-2 border-brand-300">
            <form action={startBulkImport} className="flex flex-wrap items-end gap-3">
              <div className="flex-1">
                <label className="label">Proof file</label>
                <select name="fileName" className="input">
                  {files.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.sizeMB} MB)</option>)}
                </select>
              </div>
              <button type="submit" className="btn-primary">Import ALL bulls (background)</button>
            </form>
            <p className="mt-2 text-[11px] text-slate-400">Imports every bull in the file (~99,000) with full genomics + linear conformation. Runs in the background; the app stays usable. Safe to re-run — already-imported bulls are skipped.</p>
          </Card>

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
              <button type="submit" className="btn-primary">Look up & import</button>
              <p className="text-[11px] text-slate-400">Creates/updates one animal with a full genomic evaluation + identifiers + pedigree. Source: LactanetGen.</p>
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
              <button type="submit" className="btn-secondary">Import top N</button>
              <p className="text-[11px] text-slate-400">Handy for a small working set. For the whole file, use “Import ALL bulls” above.</p>
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
