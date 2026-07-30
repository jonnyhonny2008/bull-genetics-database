import fs from "fs";
import path from "path";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { importHolsteinPaste, importHolsteinBatch } from "./actions";
import PrepareScrape from "./PrepareScrape";
import LiveScrape from "./LiveScrape";

export const dynamic = "force-dynamic";

function readExtractorSource(): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), "scripts", "holstein-extract.js"), "utf8");
  } catch {
    return "// scripts/holstein-extract.js not found — see the repo for the scraper.";
  }
}

export default function HolsteinLookupPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "upload:write")) redirect("/dashboard");

  const extractorSource = readExtractorSource();
  const imported = searchParams.imported ? Number(searchParams.imported) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Holstein.ca Lookup & Bulk Import"
        subtitle="Scrape many animals from Holstein Canada by registration number and import their identity, genetics, classification & pedigree into the database."
      />

      {imported != null && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          <div className="font-semibold">Import complete</div>
          <p className="mt-1 text-xs">
            {imported} animal(s) imported · {searchParams.created ?? 0} new · {searchParams.evals ?? 0} evaluations ·{" "}
            {searchParams.cls ?? 0} classifications · {searchParams.errors ?? 0} errors · {searchParams.skipped ?? 0} skipped.{" "}
            <a href="/animals" className="underline">View animals →</a>
          </p>
        </div>
      )}

      <Card title="Live scrape & import">
        <p className="mb-3 text-xs text-slate-500">
          Enter a registration number (or paste a list / upload a CSV) and the app drives your local Chrome through
          holstein.ca — pulling every tab (genetics, conformation, pedigree, owners, progeny) and importing into the
          database. Requires the app running locally with Chrome installed.
        </p>
        <LiveScrape />
      </Card>

      <div className="my-6 border-t border-slate-200" />

      <details className="mb-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-600">Alternative methods (browser-console &amp; paste)</summary>
        <p className="mt-2 mb-4 text-xs text-slate-500">
          Use these if you can&apos;t run the app locally with Chrome — e.g. on a hosted deployment. The console method
          runs a snippet in your own browser on holstein.ca (which downloads a batch file you then import here).
        </p>

      {/* Step 2 first (the import), so the success banner and the upload sit at the top once you have a file. */}
      <Card title="Step 2 — Import a scraped batch file">
        <form action={importHolsteinBatch} className="space-y-3">
          <div>
            <label className="label">Batch file (holstein-batch-*.json from the scraper)</label>
            <input type="file" name="batch" accept="application/json,.json" className="input" />
          </div>
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">…or paste the JSON directly</summary>
            <textarea name="batchJson" rows={5} className="input mt-2 font-mono text-[10px]" placeholder="[ { &quot;reg&quot;: &quot;HOCANM…&quot;, … } ]" />
          </details>
          <button type="submit" className="btn-primary">Import all animals</button>
        </form>
      </Card>

      <div className="my-4" />

      <Card title="Step 1 — Prepare a scrape from your reg-number list">
        <PrepareScrape extractorSource={extractorSource} />
      </Card>

      <div className="my-4" />

      <Card title="Single animal — paste one page (no scraping needed)">
        <form action={importHolsteinPaste} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Registration number *</label>
              <input name="regNo" className="input" placeholder="HOCANF121517751" required />
            </div>
            <div>
              <label className="label">Holstein animal id (optional)</label>
              <input name="holsteinAnimalId" className="input" placeholder="15884225" />
            </div>
          </div>
          <div className="rounded-md bg-slate-50 p-2 text-xs text-slate-500">
            Official page URL pattern: <code className="break-all">https://www.holstein.ca/en/AIS/AIS?animalRegNo=&lt;REG&gt;</code> — open it, copy the page, paste below.
          </div>
          <div>
            <label className="label">Pasted page content</label>
            <textarea name="pageText" rows={8} className="input font-mono text-xs" placeholder="Open the AIS link in your browser, select all (Ctrl+A), copy, and paste the page here…" />
          </div>
          <button type="submit" className="btn-primary">Parse &amp; import</button>
        </form>
      </Card>
      </details>
    </div>
  );
}
