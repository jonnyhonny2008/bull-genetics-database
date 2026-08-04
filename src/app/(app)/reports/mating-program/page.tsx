import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getMatingProgramReport, MATING_INDEXES } from "@/lib/mating-program";
import { MatingProgramResults } from "@/components/MatingProgramResults";

export const dynamic = "force-dynamic";

const POOLS = [
  { code: "blondin", label: "Blondin bulls" },
  { code: "proven", label: "Active proven" },
  { code: "genomic", label: "Active genomic" },
  { code: "all", label: "Whole database" },
];

const DEPTHS = [
  { code: "3", label: "3 generations (default)" },
  { code: "2", label: "2 generations" },
  { code: "0", label: "Off — audit mode, nothing excluded" },
];

// 0.75 is the MINIMUM, not the middle option. It is the whole reason the
// paternally blind cohort (0.583 — own pedigree line only, the sire's own
// parents unknown) is withheld instead of recommended; offering a lower value
// would move every one of those pairings into the recommendations panel under a
// green "Clear" badge without a single extra fact about the pedigree. The
// orchestrator clamps hand-edited URLs to the same minimum.
const FLOORS = ["0.75", "0.833", "1"];

export default async function MatingProgramReportPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  const report = await getMatingProgramReport(searchParams);
  const { params } = report;

  // Preserve the current run on the Excel export link.
  const exportParams = new URLSearchParams();
  for (const k of ["females", "index", "pool", "topN", "maxGen", "floor", "inactive"]) {
    const v = searchParams[k];
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/reports/mating-program/export${exportParams.toString() ? `?${exportParams}` : ""}`;

  const indexLabel = MATING_INDEXES.find((i) => i.code === params.index)?.label ?? params.index;

  const resolved = report.females.filter((f) => !f.error).length;
  const failed = report.females.length - resolved;
  const withheld = report.females.reduce((n, f) => n + f.unknown.length, 0);
  // Mean pedigree completeness across the females we could read. This is NOT
  // report.keyResolveRate — that measures what share of the ancestors met in the
  // run are animals we hold (and could therefore be matched across all their
  // registration numbers). Both are shown, each labelled for what it measures.
  const meanComplete = resolved
    ? report.females.filter((f) => !f.error).reduce((s, f) => s + f.cowComplete, 0) / resolved
    : 0;

  const auditMode = params.maxGen === 0;

  return (
    <div>
      <PageHeader
        title="Mating Program"
        subtitle="Paste your females; each one is ranked against the bull lineup by the projected parent average of the calf, with any bull sharing a registered ancestor inside three generations excluded."
        actions={
          report.females.length > 0 ? (
            <a href={exportHref} className="btn-primary">⬇ Export to Excel</a>
          ) : undefined
        }
      />

      {/* The ceiling, stated up front rather than buried in a footnote. */}
      <div className="mb-4 rounded-md border border-navy-200 bg-navy-50 px-3 py-2.5 text-xs leading-relaxed text-navy-900">
        <strong>What this check does and does not do.</strong> The screen stops at{" "}
        <strong>three generations</strong>. Holstein populations share great-great-grandsires routinely, so this report
        will correctly say &ldquo;no relatives within 3 generations&rdquo; about a mating that still carries real
        ancestral inbreeding. <strong>A green &ldquo;Clear&rdquo; badge is not a claim of zero inbreeding.</strong> With
        today&rsquo;s pedigree data roughly half the lineup can land in{" "}
        <em>&ldquo;not enough pedigree to check&rdquo;</em> — those bulls are withheld from the ranking rather than
        recommended, because a bull we cannot screen is not the same thing as a bull we cleared.
      </div>

      {report.warnings.map((w, i) => (
        <div key={i} className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {w}
        </div>
      ))}

      {auditMode && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          <strong>Audit mode — screening is off.</strong> Bulls are ranked without any relatedness exclusion. These
          rows are not mating recommendations.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Females resolved"
          value={fmtNum(resolved)}
          hint={failed ? `${fmtNum(failed)} could not be read` : undefined}
          tone={failed ? "warn" : "good"}
        />
        <StatCard label="Bulls considered" value={fmtNum(report.bullsConsidered)} />
        <StatCard
          label="Median exclusion"
          value={report.females.length ? `${Math.round(report.medianExclusionPct)}%` : "—"}
          hint="of the pool, per female"
        />
        <StatCard
          label="Withheld unverifiable"
          value={fmtNum(withheld)}
          hint="below the completeness floor"
          tone={withheld ? "warn" : "default"}
        />
        <StatCard label="Inactive suppressed" value={fmtNum(report.inactiveSuppressed)} hint="toggle below to include" />
        <StatCard
          label="Mean female pedigree"
          value={report.females.length ? `${Math.round(meanComplete * 100)}%` : "—"}
          hint="share of 14 ancestor slots read"
        />
      </div>

      {/* The strength of the screen itself, not of any one pedigree: an ancestor
          we hold can be matched across every registration number he carries, one
          we do not is matched on the raw string only. A low rate here means two
          spellings of the same bull can slip past the exclusion. */}
      {report.females.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-500">
          Ancestor resolve rate <strong>{Math.round(report.keyResolveRate * 100)}%</strong> — the share of ancestors met
          in this run that are animals we hold, and could therefore be matched across all of their registration numbers.
          The rest were matched on the pedigree string alone.
        </p>
      )}

      <form method="get" className="card card-pad mt-4">
        <div className="mb-3">
          <label className="label" htmlFor="females">
            Females — one registration per line (or comma/tab separated), up to 50
          </label>
          <textarea
            id="females"
            name="females"
            rows={5}
            defaultValue={params.females.join("\n")}
            placeholder={"HOCANM 13486161\nHO840M0000111..."}
            className="input w-full font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Canadian (HOCANM…) and US/840 (HO840M…) registrations are both accepted. Females not in the database are
            looked up live from Lactanet for this run only and are never saved.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="pool">Bull pool</label>
            <select id="pool" name="pool" defaultValue={params.pool} className="input min-w-[170px]">
              {POOLS.map((p) => (
                <option key={p.code} value={p.code}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="index">Rank on</label>
            <select id="index" name="index" defaultValue={params.index} className="input">
              {MATING_INDEXES.map((i) => (
                <option key={i.code} value={i.code}>{i.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="topN">Bulls per female</label>
            <input
              id="topN"
              name="topN"
              type="number"
              min={1}
              max={50}
              defaultValue={params.topN}
              className="input w-28"
            />
          </div>
          <div>
            <label
              className="label"
              htmlFor="maxGen"
              title="How many generations back a shared ancestor is looked for. Deeper is stricter."
            >
              Screening depth
            </label>
            <select id="maxGen" name="maxGen" defaultValue={String(params.maxGen)} className="input min-w-[190px]">
              {DEPTHS.map((d) => (
                <option key={d.code} value={d.code}>{d.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label
              className="label"
              htmlFor="floor"
              title="How much of a pedigree must be readable before a 'no shared ancestor' result is trusted. 0.583 is a pedigree with the sire's parents missing; 0.833 is one with them present. 0.75 is the minimum — a lower bar would certify pedigrees that cannot support the answer."
            >
              Completeness floor
            </label>
            <select id="floor" name="floor" defaultValue={String(params.floor)} className="input min-w-[150px]">
              {FLOORS.map((f) => (
                <option key={f} value={f}>
                  {Math.round(Number(f) * 100)}%{f === "0.75" ? " (default, minimum)" : ""}
                </option>
              ))}
            </select>
            {report.effectiveFloor !== params.floor && (
              <p className="mt-1 text-[11px] text-slate-500">
                Applied at {Math.round(report.effectiveFloor * 100)}% — completeness is measured over the{" "}
                {params.maxGen} generations screened, so the bar is scaled to demand the same evidence.
              </p>
            )}
          </div>
          <label
            className="flex items-center gap-1.5 pb-2 text-xs text-slate-600"
            title="A stud routinely holds saleable semen on bulls that no longer receive proofs."
          >
            <input type="checkbox" name="inactive" value="1" defaultChecked={params.includeInactive} />
            Include inactive bulls
          </label>
          <button type="submit" className="btn-primary">Generate</button>
          <a href="/reports/mating-program" className="btn-secondary">Reset</a>
        </div>
      </form>

      <div className="mt-4">
        <MatingProgramResults report={report} indexLabel={indexLabel} />
      </div>
    </div>
  );
}
