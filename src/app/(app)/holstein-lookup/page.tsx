import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { importHolsteinPaste } from "./actions";

export const dynamic = "force-dynamic";

export default function HolsteinLookupPage() {
  const user = currentUser();
  if (!can(user?.role, "upload:write")) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Holstein.ca Lookup (by Reg #)"
        subtitle="Capture a female's Holstein Canada page — name, genetics, pedigree, milk & classification — into the review queue."
      />

      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="font-semibold">How this works (and why)</div>
        <p className="mt-1 text-xs">
          Holstein.ca&apos;s robots.txt disallows automated access to the <code>/en/AIS/</code> pages, so this tool does
          <strong> not</strong> scrape their site. Instead: enter a registration number, click the link to open the official
          page <em>in your own signed-in browser</em>, copy the page, and paste it below. The app extracts what it can and
          sends it to the review queue for approval. Provide one sample page and the parser can be tuned to pull every field exactly.
        </p>
      </div>

      <Card title="Capture">
        <form action={importHolsteinPaste} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Registration number *</label>
              <input name="regNo" className="input" placeholder="HOCANF14824471" required />
            </div>
            <div>
              <label className="label">Holstein animal id (optional)</label>
              <input name="holsteinAnimalId" className="input" placeholder="15883773" />
            </div>
          </div>

          <OpenLinkHint />

          <div>
            <label className="label">Pasted page content</label>
            <textarea name="pageText" rows={10} className="input font-mono text-xs" placeholder="Open the AIS link in your logged-in browser, select all (Ctrl+A), copy, and paste the page here…" />
            <p className="mt-1 text-[11px] text-slate-400">The parser reads name, genomic evaluation (GLPI, Pro$, production, functional, linear conformation), classification (VG/EX + section scores), and pedigree.</p>
          </div>

          <button type="submit" className="btn-primary">Parse &amp; import</button>
        </form>
      </Card>
    </div>
  );
}

// Small client-free helper that builds the official link from the typed reg number.
function OpenLinkHint() {
  return (
    <div className="rounded-md bg-slate-50 p-2 text-xs text-slate-500">
      Official page URL pattern:{" "}
      <code className="break-all">https://www.holstein.ca/en/AIS/AIS?animalRegNo=&lt;REG&gt;</code>
      {" "}— open it in your browser (where you&apos;re logged in), then copy &amp; paste the page above.
    </div>
  );
}
