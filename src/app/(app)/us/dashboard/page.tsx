import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { PageHeader, Card, StatCard, Badge } from "@/components/ui";
import { INDEX_REGISTRY, resolveTpiFormula, formulaConfidence } from "@/lib/us-cdcb/index-registry";
import { JPI_REGISTRY, resolveJpiFormula } from "@/lib/us-cdcb/jpi";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

// The American side's landing page. Until the CDCB importer lands there is no US
// evaluation data in the database, so this reports what the ENGINE is ready to do
// rather than inventing lineup numbers — an empty dashboard that claims "0 bulls"
// would read as a broken import rather than an un-run one.

const CURRENT_ROUND = "2604";

export default function UsDashboardPage() {
  const user = currentUser();
  if (!user) redirect("/login");

  const tpi = resolveTpiFormula(CURRENT_ROUND);
  const jpi = resolveJpiFormula(CURRENT_ROUND);

  return (
    <div>
      <PageHeader
        title="American genetics"
        subtitle={
          <span>
            CDCB evaluations — PTAs in pounds, published April / August / December.{" "}
            <Badge tone="blue">April 2026</Badge>
          </span>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Evaluation round" value="April 2026" hint="round 2604 · official" />
        <StatCard label="Breeds published" value={CDCB_BREEDS.length} hint={CDCB_BREEDS.join(" · ")} tone="accent" />
        <StatCard label="Index formulas" value={INDEX_REGISTRY.tpi.length + JPI_REGISTRY.length} hint="versioned by round" />
        <StatCard label="Animals imported" value="—" hint="importer not yet run" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Holstein — TPI">
          <dl className="space-y-2 text-sm">
            <Row k="Formula in force" v={`${tpi.tpi.label} (constant ${tpi.tpi.constant})`} />
            <Row k="Feed Efficiency" v={tpi.fe?.label ?? "—"} />
            <Row k="Fertility Index" v={tpi.fi?.label ?? "—"} />
            <Row k="Health Trait Index" v={tpi.ht?.label ?? "—"} />
            <Row k="Composites" v={`${tpi.udc?.label ?? "—"} · ${tpi.flc?.label ?? "—"}`} />
            <Row k="Confidence" v={formulaConfidence(tpi)} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            TPI is <strong>calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
            Association USA formula in force for each round. It is not an official Holstein Association
            publication, and is typically within ±3 points of the published figure. TPI is a registered
            trademark of Holstein Association USA.
          </p>
        </Card>

        <Card title="Jersey — JPI">
          <dl className="space-y-2 text-sm">
            <Row k="Formula in force" v={`${jpi.label}${jpi.constant ? ` (constant +${jpi.constant})` : " (no constant)"}`} />
            <Row k="Udder depth optimum" v={String(jpi.udOptimum)} />
            <Row k="Caps" v={`fore udder ≤ ${jpi.fuCap} · rear udder height ≤ ${jpi.ruhCap}`} />
            <Row k="Confidence" v={jpi.confidence} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            JPI is calculated from the American Jersey Cattle Association&rsquo;s published constants and
            reproduces their Green Book values exactly. AJCA does not publish JPI for crossbreds.
          </p>
        </Card>
      </div>

      <Card title="What is different on this side" className="mt-4">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
          <li><strong>Values are PTAs in pounds</strong>, not EBVs in kilograms — roughly half a Canadian breeding value, so no number here is directly comparable to its Canadian counterpart.</li>
          <li><strong>One file per round.</strong> CDCB has no official/interim pair, so there is no interim report on this side.</li>
          <li><strong>No Rollback Resistance.</strong> That measures Canada&rsquo;s annual April re-basing; the US re-bases roughly every five years, so the metric has no US meaning.</li>
          <li><strong>Proven vs genomic</strong> comes from CDCB&rsquo;s per-trait evaluation flag, and <strong>active</strong> from the AI status file — not from carrying a NAAB code.</li>
        </ul>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5 last:border-0">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-medium text-slate-800">{v}</dd>
    </div>
  );
}
