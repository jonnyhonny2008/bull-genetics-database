import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getMatingProgramReport, MATING_INDEXES } from "@/lib/mating-program";
import { BALANCE_STEP, blendLabel, MAX_BALANCE, MAX_SELECTED_TRAITS, MAX_WEIGHT, MIN_BALANCE, MIN_WEIGHT, WEIGHT_STEP } from "@/lib/mating-score";
import { MatingProgramResults } from "@/components/MatingProgramResults";

export const dynamic = "force-dynamic";

/**
 * The "Rank on" slots. One select + one weight per slot, because a plain GET
 * form cannot join four fields into a single parameter without JavaScript.
 * Slot 1 is the field this report has always had — `?index=LPI` is still exactly
 * one trait ranked on its own projected calf value, and every saved link keeps
 * working. The orchestrator also accepts the compact `?index=LPI:2,CONF` form.
 */
const TRAIT_SLOTS = [
  { code: "index", weight: "weight1" },
  { code: "index2", weight: "weight2" },
  { code: "index3", weight: "weight3" },
  { code: "index4", weight: "weight4" },
].slice(0, MAX_SELECTED_TRAITS);

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
  for (const k of [
    "females", "index", "pool", "topN", "maxGen", "floor", "inactive", "naabOnly", "crossBreed", "balance",
    // Every trait slot travels too, or the export would silently be a different
    // ranking from the one on screen.
    ...TRAIT_SLOTS.flatMap((s) => [s.code, s.weight]),
  ]) {
    const v = searchParams[k];
    if (v) exportParams.set(k, v);
  }
  const exportHref = `/reports/mating-program/export${exportParams.toString() ? `?${exportParams}` : ""}`;

  // One trait: its own label, exactly as before. Several: the blend, weights and
  // all — "LPI ×2 + Conformation".
  const indexLabel = blendLabel(params.selected);

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

        {/* Rank on — one trait, or a weighted blend of up to four. Each slot is
            a plain select + number input so the whole form stays a GET form
            with no JavaScript and every control is reachable by keyboard. */}
        <fieldset className="mb-3 rounded-md border border-slate-200 px-3 pb-3 pt-1">
          <legend className="label px-1">Rank on</legend>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            {TRAIT_SLOTS.map((slot, i) => {
              const chosen = params.selected[i];
              return (
                <div key={slot.code} className="flex items-end gap-1.5">
                  <div>
                    <label className="label" htmlFor={slot.code}>
                      {i === 0 ? "Trait" : `+ trait ${i + 1}`}
                    </label>
                    <select
                      id={slot.code}
                      name={slot.code}
                      defaultValue={chosen?.code ?? ""}
                      className="input min-w-[150px]"
                    >
                      {i > 0 && <option value="">— none —</option>}
                      {MATING_INDEXES.map((m) => (
                        <option key={m.code} value={m.code}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={slot.weight}>Weight</label>
                    <input
                      id={slot.weight}
                      name={slot.weight}
                      type="number"
                      step={WEIGHT_STEP}
                      min={MIN_WEIGHT}
                      max={MAX_WEIGHT}
                      defaultValue={chosen?.weight ?? 1}
                      className="input w-20"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            One trait ranks on the projected calf value itself, exactly as before. Pick two or more and each trait is
            measured against the bull pool first, then blended in the weights you set — so LPI&rsquo;s thousands cannot
            drown out Conformation&rsquo;s single digits. The result is a <strong>Match score</strong>: 100 is the pool
            average and every 5 points is one standard deviation. A bull missing any trait in the blend is left out
            rather than scored on the rest.
          </p>

          {/* Balance — the no-holes dial. Only bites on a blend, because with a
              single trait a bull's worst trait IS his only trait. */}
          {params.selected.length > 1 && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <label className="label" htmlFor="balance">
                Penalty for a weakness — {Math.round(params.balance * 100)}%
              </label>
              <input
                id="balance"
                name="balance"
                type="range"
                min={MIN_BALANCE}
                max={MAX_BALANCE}
                step={BALANCE_STEP}
                defaultValue={params.balance}
                className="w-full max-w-md"
              />
              <div className="flex max-w-md justify-between text-[10px] text-slate-400">
                <span>0 — average the traits</span>
                <span>100 — rank on the weakest</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                A plain average lets a bull buy off a hole: <strong>+3 SD on one trait and −1 on another</strong> scores
                the same as <strong>+1 on both</strong>, and those are not the same animal. This dial mixes the average
                with the bull&rsquo;s <strong>worst</strong> selected trait, so a weakness costs him something no amount
                of excess elsewhere fully pays back — a balanced bull with no holes ranks ahead of a spiky one.
              </p>
            </div>
          )}
        </fieldset>

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
          <label
            className="flex items-center gap-1.5 pb-2 text-xs text-slate-600"
            title="Only bulls carrying a NAAB stud code — i.e. semen that can actually be ordered. A bull with no stud code cannot be bought, so recommending him wastes a slot."
          >
            <input type="checkbox" name="naabOnly" value="1" defaultChecked={params.naabOnly} />
            NAAB code only
          </label>
          <label
            className="flex items-center gap-1.5 pb-2 text-xs text-slate-600"
            title="Off by default: a bull is only offered for a female of his own breed. Tick this to allow deliberate crossbreeding."
          >
            <input type="checkbox" name="crossBreed" value="1" defaultChecked={params.crossBreed} />
            Allow other breeds
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
