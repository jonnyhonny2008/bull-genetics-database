import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

// One entry per report. Add a report by appending here + its page under /reports.
const REPORTS = [
  {
    href: "/reports/round-summary",
    title: "What Changed This Round",
    tag: "Digest",
    blurb: "A lineup-level digest of the newest proof round: how many bulls were updated, the average LPI move, the top gainers and biggest drops, and which bulls moved unusually on a key trait. The at-a-glance companion to the trait-by-trait Proof Change Report.",
    ready: true,
  },
  {
    href: "/reports/proof-changes",
    title: "Proof Change Report",
    tag: "NAAB bulls",
    blurb: "How each NAAB bull moved between its latest proof and the previous official proof (official vs interim is read from the Lactanet file, not the month). Ranks bulls by their biggest changes, flags any trait that moved 10% or more, and exports to Excel.",
    ready: true,
  },
  {
    href: "/reports/interim-changes",
    title: "Interim Proof Change Report",
    tag: "NAAB bulls",
    blurb: "The same trait-by-trait movement, but between each bull's latest proof and the run immediately before it — interim to interim, spanning official proofs too. Ranks by the biggest changes, flags unusual movers, and exports to Excel.",
    ready: true,
  },
  {
    href: "/reports/round-compare?type=ebv",
    title: "Breed Proof Change — Proven (EBV)",
    tag: "Breed · HTML",
    blurb: "A breed-level comparison of the daughter-proven (EBV) NAAB Holstein bulls between any two proof rounds, as a self-contained HTML file you can email. Breed-wide average change boxes, LPI and Conformation gainers/losers, an All Breed / Top 1,000 / Top 200 toggle that works offline, a full Top-100 table, and the newly-proven (PA→EBV) bulls at the top.",
    ready: true,
  },
  {
    href: "/reports/round-compare?type=pa",
    title: "Breed Proof Change — Genomic (PA)",
    tag: "Breed · HTML",
    blurb: "A breed-level comparison of the genomic (PA) NAAB Holstein bulls between any two proof rounds, as a self-contained HTML file you can email. Breed-wide average change boxes, LPI and Conformation gainers/losers, an All Breed / Top 1,000 / Top 200 toggle that works offline, and a full Top-100 table.",
    ready: true,
  },
  {
    href: "/reports/mating-program",
    title: "Mating Program",
    tag: "Mating",
    blurb: "Paste up to 50 females and get each one ranked against the bull lineup by the projected parent average of the calf. Any bull sharing a registered ancestor with her inside three generations is excluded and listed with the shared ancestor named, and bulls whose pedigree is too thin to screen are withheld rather than recommended.",
    ready: true,
  },
];

export default function ReportsPage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  return (
    <div>
      <PageHeader title="Reports" subtitle="Generate a report at the click of a button." />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <Card key={r.href} title={r.title} actions={<Badge tone="brand">{r.tag}</Badge>}>
            <p className="mb-4 text-sm text-slate-600">{r.blurb}</p>
            {r.ready ? (
              <Link href={r.href} className="btn-primary">Generate report →</Link>
            ) : (
              <span className="btn-secondary cursor-not-allowed opacity-50">Coming soon</span>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
