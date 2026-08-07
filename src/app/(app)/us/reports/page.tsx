import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

// The American reports index. Mirrors /reports, but it is a SHORTER list on
// purpose — see the note rendered below the cards. Add a report by appending
// here + its page under /us/reports.
const REPORTS = [
  {
    href: "/us/reports/round-summary",
    title: "What Changed This Round",
    tag: "Digest",
    blurb: "A lineup-level digest of the newest CDCB round: how many bulls were updated, the average GTPI and Net Merit move, the top gainers and the biggest drops, and which bulls moved unusually on a key trait. The at-a-glance companion to the trait-by-trait Proof Change Report.",
    ready: true,
  },
  {
    href: "/us/reports/proof-changes",
    title: "Proof Change Report",
    tag: "NAAB bulls",
    blurb: "How each NAAB bull moved between the latest official CDCB round and the one before it, trait by trait, in pounds. Ranks bulls by their biggest changes and flags any trait that moved unusually far.",
    ready: true,
  },
  {
    href: "/us/reports/round-compare",
    title: "Round Comparison",
    tag: "Any two rounds",
    blurb: "Pick ANY two CDCB periods on file and see how the population moved between them — per breed, trait by trait, with the biggest risers and fallers ranked within their own breed. Warns you when the two periods are not peers, because a provisional monthly add and an official round are not comparable populations.",
    ready: true,
  },
];

export default function UsReportsPage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  return (
    <div>
      <PageHeader
        title="American reports"
        subtitle="Generated from CDCB evaluations — PTAs in pounds, official rounds only."
      />

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

      {/* Anyone arriving from the Canadian side will count the cards and wonder
          what happened to the interim report. Answer it here rather than let it
          read as a gap in the build. */}
      <Card title="Why there is no Interim Proof Change Report here" className="mt-4">
        <p className="text-sm text-slate-600">
          On the Canadian side, Lactanet ships <strong>two files per round</strong> — an official set and an
          interim set — so a bull has both an official proof and a later interim run to compare against, and
          the Interim Proof Change Report exists to compare them.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          <strong>CDCB ships one file per round.</strong> There is no official/interim pair on this side, so
          an interim report would have nothing to put on either end of the comparison. It is not missing from
          the American build — it has no American meaning. The monthly and weekly CDCB runs are stored, but
          they are additions between rounds rather than a second reading of the same round, and no report
          ranks a bull against them.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          The other Canadian metric with no counterpart here is <strong>Rollback Resistance</strong>, which
          measures Canada&rsquo;s annual April re-basing. The US re-bases roughly every five years, so the
          same calculation would be a number built on a false premise.
        </p>
      </Card>
    </div>
  );
}
