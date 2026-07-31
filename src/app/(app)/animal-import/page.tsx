import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import LiveScrape from "./LiveScrape";

export const dynamic = "force-dynamic";

export default function AnimalImportPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "upload:write")) redirect("/dashboard");

  const imported = searchParams.imported ? Number(searchParams.imported) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Animal Lookup & Import"
        subtitle="Enter a registration number to pull an animal's full record — identity, genetics, conformation, pedigree, progeny and (for cows) classification & lactations — straight into the database."
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

      <Card title="Look up &amp; import by registration number">
        <p className="mb-3 text-xs text-slate-500">
          Source: <span className="font-medium">Lactanet Genetics</span>. Look up one animal, or paste a list / upload a
          CSV to import many. Registration numbers look like <code>HOCANM13486161</code> (breed + country + sex + number).
          No browser or local setup required — it runs the same here and on the hosted site.
        </p>
        <LiveScrape />
      </Card>

      <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
        Genetic evaluations are also imported in bulk from the official Lactanet proof CSV on the{" "}
        <a href="/import-proofs" className="underline">Proof Import</a> page. Owner history and show results are
        breed-association records that Lactanet does not publish, so they are not part of this import.
      </p>
    </div>
  );
}
