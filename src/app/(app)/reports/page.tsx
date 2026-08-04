import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

// One entry per report. Add a report by appending here + its page under /reports.
const REPORTS = [
  {
    href: "/reports/proof-changes",
    title: "Proof Change Report",
    tag: "NAAB bulls",
    blurb: "How each NAAB bull moved between its latest proof and the previous official (April / August / December) proof. Ranks bulls by their biggest changes, flags any trait that moved 10% or more, and exports to Excel.",
    ready: true,
  },
  {
    href: "/reports/proof-forecast",
    title: "Projected Proof Report",
    tag: "Projection",
    blurb: "The proof change report run forwards: a modelled next-round proof for every NAAB bull, trait by trait, with an uncertainty range on each number. Charts the lineup trend and its projection, prints its own backtested accuracy, and lets you open any single bull's full projected index and linear profile.",
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
