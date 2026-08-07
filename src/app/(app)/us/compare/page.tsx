import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { cached } from "@/lib/aggregate-cache";
import { PageHeader, Card, EmptyState, Badge } from "@/components/ui";
import { US_KEY_TRAITS, formatUsTrait, type UsKeyTrait } from "@/lib/us-cdcb/key-traits";
import BullComparePicker from "@/components/BullComparePicker";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Side-by-side sire comparison, American side.
//
// Reads UsEvaluation ONLY. The Canadian /compare reads GeneticEvaluation, whose
// values are EBVs in kilograms; these are PTAs in pounds, roughly half a Canadian
// breeding value. The two must never meet in one table.
//
// The hard part here is not the layout, it is DIRECTION. The Canadian page can
// take higherIsBetter straight off TraitDefinition and highlight the max. CDCB
// has no such flag and several of its traits have an intermediate optimum — Rump
// Angle most obviously, but also Teat Length and Rear Legs Side View, whose own
// composite formulas penalise the ABSOLUTE value (see index-registry.ts: TLstar,
// SVstar, RPstar). Highlighting "best" on those would tell a customer the wrong
// bull is the right one. So direction is declared per trait below, and anything
// not confidently directional is rendered plainly with a tooltip saying why.
// ---------------------------------------------------------------------------

const MAX = 6;

/** Where a row's value comes from — most traits live in the GPTA map, the
 *  computed indexes and composites live in their own columns. */
type ValueSource = "gpta" | "tpi" | "jpi" | "udc" | "flc";

interface CompareTrait {
  /** CDCB trait code, or the computed index's key. */
  code: string;
  label: string;
  decimals: number;
  /**
   * higher / lower  — safe to rank, so a best value is highlighted.
   * intermediate    — there IS an optimum; the extremes are not best.
   * unknown         — this app does not assert a direction for it.
   * The last two are rendered plainly. Both are honest answers; guessing is not.
   */
  direction: "higher" | "lower" | "intermediate" | "unknown";
  source: ValueSource;
  /** An absolute score (SCS 2.90, calving ease 6.9%) rather than a deviation, so
   *  it takes no explicit + sign. */
  absolute?: boolean;
  unit?: "$" | null;
}

interface TraitGroup { category: string; traits: CompareTrait[] }

const t = (
  code: string,
  label: string,
  decimals: number,
  direction: CompareTrait["direction"],
  extra: Partial<CompareTrait> = {},
): CompareTrait => ({ code, label, decimals, direction, source: "gpta", ...extra });

/**
 * The CDCB trait catalogue, in display order.
 *
 * Directions for the fitness, calving and health traits are taken from the sign
 * their term carries in HAUSA's own TPI formula (index-registry.ts) rather than
 * from intuition — DCE and DSB enter at -0.5 and -1.5, so lower is better; every
 * health-trait term is positive, so higher is better.
 *
 * The linear type traits are the ones that need care. Those that appear with a
 * positive weight in UDC or FLC are ranked; STA carries a NEGATIVE weight in both
 * composites and a positive one in BWC, and the body traits only ever feed BWC,
 * which itself enters Feed Efficiency negatively — so none of those has a single
 * "more is better" answer and none is ranked here.
 */
const TRAIT_GROUPS: TraitGroup[] = [
  {
    category: "Merit indexes",
    traits: [
      { code: "GTPI", label: "GTPI (calc.)", decimals: 0, direction: "higher", source: "tpi", absolute: true },
      { code: "JPI", label: "JPI (calc.)", decimals: 0, direction: "higher", source: "jpi", absolute: true },
      t("NM", "Net Merit", 0, "higher", { unit: "$" }),
      t("CM", "Cheese Merit", 0, "higher", { unit: "$" }),
      t("FM", "Fluid Merit", 0, "higher", { unit: "$" }),
      t("GM", "Grazing Merit", 0, "higher", { unit: "$" }),
    ],
  },
  {
    category: "Production (PTA, lb)",
    traits: [
      t("MILK", "Milk", 0, "higher"),
      t("FAT", "Fat", 0, "higher"),
      t("PRO", "Protein", 0, "higher"),
      t("FATPCT", "Fat %", 2, "higher"),
      t("PROPCT", "Protein %", 2, "higher"),
    ],
  },
  {
    category: "Fitness & longevity",
    traits: [
      t("PL", "Productive Life", 1, "higher"),
      t("LIV", "Cow Livability", 1, "higher"),
      t("HLV", "Heifer Livability", 1, "higher"),
      t("SCS", "Somatic Cell Score", 2, "lower", { absolute: true }),
      t("FS", "Feed Saved", 0, "higher"),
      // Gestation length has no single good direction — short is favourable up to
      // a point and then is not — so it is shown but not ranked.
      t("GL", "Gestation Length", 1, "intermediate"),
      t("RFI", "Residual Feed Intake", 0, "unknown"),
    ],
  },
  {
    category: "Fertility",
    traits: [
      t("DPR", "Daughter Pregnancy Rate", 1, "higher"),
      t("HCR", "Heifer Conception Rate", 1, "higher"),
      t("CCR", "Cow Conception Rate", 1, "higher"),
      t("EFC", "Early First Calving", 1, "higher"),
    ],
  },
  {
    category: "Calving (%)",
    traits: [
      t("SCE", "Sire Calving Ease", 1, "lower", { absolute: true }),
      t("DCE", "Daughter Calving Ease", 1, "lower", { absolute: true }),
      t("SSB", "Sire Stillbirth", 1, "lower", { absolute: true }),
      t("DSB", "Daughter Stillbirth", 1, "lower", { absolute: true }),
    ],
  },
  {
    category: "Health traits",
    traits: [
      t("MAS", "Mastitis Resistance", 1, "higher"),
      t("MET", "Metritis Resistance", 1, "higher"),
      t("RPL", "Retained Placenta Resistance", 1, "higher"),
      t("DAB", "Displaced Abomasum Resistance", 1, "higher"),
      t("KET", "Ketosis Resistance", 1, "higher"),
      t("MFV", "Milk Fever Resistance", 1, "higher"),
    ],
  },
  {
    category: "Type & composites",
    traits: [
      t("PTAT", "Type (PTAT)", 2, "higher"),
      { code: "UDC", label: "Udder Composite (calc.)", decimals: 2, direction: "higher", source: "udc" },
      { code: "FLC", label: "Feet & Legs Composite (calc.)", decimals: 2, direction: "higher", source: "flc" },
    ],
  },
  {
    category: "Linear type",
    traits: [
      t("STA", "Stature", 2, "intermediate"),
      t("STR", "Strength", 2, "unknown"),
      t("BDE", "Body Depth", 2, "unknown"),
      t("DFM", "Dairy Form", 2, "unknown"),
      t("TRW", "Thurl Width", 2, "unknown"),
      t("RPA", "Rump Angle", 2, "intermediate"),
      t("FTA", "Foot Angle", 2, "higher"),
      t("RLS", "Rear Legs Side View", 2, "intermediate"),
      t("RLR", "Rear Legs Rear View", 2, "higher"),
      t("FLS", "Feet & Legs Score", 2, "higher"),
      t("FUA", "Fore Udder Attachment", 2, "higher"),
      t("RUH", "Rear Udder Height", 2, "higher"),
      t("RUW", "Rear Udder Width", 2, "higher"),
      t("UCL", "Udder Cleft", 2, "higher"),
      t("UDP", "Udder Depth", 2, "higher"),
      t("FTP", "Front Teat Placement", 2, "higher"),
      t("RTP", "Rear Teat Placement", 2, "intermediate"),
      t("TLG", "Teat Length", 2, "intermediate"),
    ],
  },
];

const CATALOGUED = new Set(TRAIT_GROUPS.flatMap((g) => g.traits.map((x) => x.code)));

/** The seven headline traits format exactly as they do on /us/animals. */
const KEY_BY_CODE = new Map<string, UsKeyTrait>(US_KEY_TRAITS.map((k) => [k.code, k]));

const DIRECTION_NOTE: Record<CompareTrait["direction"], string | undefined> = {
  higher: undefined,
  lower: undefined,
  intermediate: "Intermediate optimum — neither the highest nor the lowest value is best, so no bull is highlighted on this row.",
  unknown: "No ranking direction is asserted for this trait, so no bull is highlighted on this row.",
};

function fmt(trait: CompareTrait, v: number | null | undefined): string {
  const key = KEY_BY_CODE.get(trait.code);
  if (key) return formatUsTrait(key, v);
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(trait.decimals);
  const signed = !trait.absolute && v > 0 ? `+${s}` : s;
  return trait.unit === "$" ? `$${signed}` : signed;
}

/** Parse a stored code→value map. A malformed blob is treated as no data rather
 *  than crashing the whole comparison. */
function readMap(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export default async function UsComparePage({ searchParams }: { searchParams: { bulls?: string } }) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/us/dashboard");

  const ids = (searchParams.bulls ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX);

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let missingTables = false;
  try {
    data = await load(ids);
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, say so
    // plainly rather than rendering a 500 — this is a setup state, not a fault.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) missingTables = true;
    else throw e;
  }

  if (missingTables || !data) {
    return (
      <div>
        <PageHeader title="Compare bulls · American" subtitle="CDCB evaluations" />
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
        </Card>
      </div>
    );
  }

  const { bulls, aiByAnimal, hasOfficialRound } = data;
  const selected = bulls.map((b) => ({ id: b.usAnimalId, name: (b.usAnimal.name ?? b.usAnimal.id17) }));

  // code -> value per bull, one map each, so a row lookup is O(1) per column.
  const valueMaps = bulls.map((b) => {
    const gpta = readMap(b.gptaJson);
    const m = new Map<string, number>();
    for (const [code, v] of Object.entries(gpta)) if (typeof v === "number") m.set(code, v);
    if (b.tpi != null) m.set("GTPI", b.tpi);
    if (b.jpi != null) m.set("JPI", b.jpi);
    if (b.udc != null) m.set("UDC", b.udc);
    if (b.flc != null) m.set("FLC", b.flc);
    return m;
  });
  const relMaps = bulls.map((b) => readMap(b.relJson));

  // Any trait a bull carries that the catalogue above does not name still gets a
  // row — CDCB's published trait set has grown over time, and a value silently
  // disappearing because this file is out of date would be worse than an unlabelled
  // row. Unnamed means undirected, so none of them is ranked.
  const extraCodes = new Set<string>();
  valueMaps.forEach((m) => m.forEach((_v, code) => { if (!CATALOGUED.has(code)) extraCodes.add(code); }));
  const groups: TraitGroup[] = [
    ...TRAIT_GROUPS,
    ...(extraCodes.size
      ? [{
          category: "Other published traits",
          traits: [...extraCodes].sort().map((code) => t(code, code, 2, "unknown")),
        }]
      : []),
  ]
    // Drop rows no selected bull carries, so a Jersey comparison isn't a wall of dashes.
    .map((g) => ({ category: g.category, traits: g.traits.filter((x) => valueMaps.some((m) => m.get(x.code) != null)) }))
    .filter((g) => g.traits.length > 0);

  /**
   * The best value in a row, or null when the row must not be highlighted.
   *
   * Null is returned for intermediate-optimum and undirected traits, for rows
   * where fewer than two bulls have a value, and for rows where every bull is
   * equal — "best" means nothing in any of those cases.
   */
  const bestOf = (trait: CompareTrait): number | null => {
    if (trait.direction !== "higher" && trait.direction !== "lower") return null;
    const vals = valueMaps.map((m) => m.get(trait.code)).filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    const max = Math.max(...vals), min = Math.min(...vals);
    if (max === min) return null;
    return trait.direction === "lower" ? min : max;
  };

  const showsTpi = bulls.some((b) => b.tpi != null);

  return (
    <div>
      <PageHeader
        title="Compare bulls · American"
        subtitle="CDCB evaluations side by side — PTAs in pounds, not Canadian EBVs in kilograms. The best value in each row is highlighted, except on traits with an intermediate optimum."
      />

      <div className="mb-4">
        <BullComparePicker selected={selected} system="us" basePath="/us/compare" max={MAX} />
      </div>

      {bulls.length < 2 ? (
        <EmptyState
          message={
            !hasOfficialRound
              ? "No bulls have an official CDCB round yet. Run a CDCB round through the importer to populate this page."
              : bulls.length === 1
                ? "Add at least one more bull to compare."
                : "Pick two or more bulls above to compare them side by side."
          }
        />
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="sticky left-0 z-10 bg-slate-50 px-3 py-3 text-left font-semibold text-slate-500">Trait</th>
                  {bulls.map((b) => {
                    const ai = aiByAnimal.get(b.id17);
                    return (
                      <th key={b.usAnimalId} className="min-w-[10rem] px-3 py-3 text-left align-top">
                        <Link href={`/us/animals/${b.usAnimalId}`} className="font-semibold text-brand-700 hover:underline">{(b.usAnimal.name ?? b.usAnimal.id17)}</Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {/* Proven vs genomic is CDCB's per-trait-group flag, not a
                              property of the bull — IS_PTA_MILK is the production one. */}
                          {b.isPtaMilk === true ? <Badge tone="green">Daughter-proven</Badge>
                            : b.isPtaMilk === false ? <Badge tone="blue">Genomic</Badge> : null}
                          {ai === "A" ? <Badge tone="brand">Active AI</Badge>
                            : ai === "G" ? <Badge tone="purple">Marketed young</Badge>
                            : ai === "F" ? <Badge tone="amber">Foreign</Badge> : null}
                        </div>
                        <div className="mt-1 text-[11px] font-normal text-slate-500">
                          {b.naabCode ? <span>{b.naabCode} · </span> : null}
                          {b.evalBreed ?? ""}{b.roundCode ? ` · ${b.roundCode}` : ""}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.category}>
                    <tr className="bg-slate-100/70">
                      <td colSpan={bulls.length + 1} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.category}</td>
                    </tr>
                    {g.traits.map((trait) => {
                      const best = bestOf(trait);
                      const note = DIRECTION_NOTE[trait.direction];
                      return (
                        <tr key={trait.code} className="border-b border-slate-100">
                          <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium text-slate-700" title={note}>
                            {trait.label}
                            {note && <span className="ml-1 cursor-help text-slate-400" aria-hidden>*</span>}
                          </th>
                          {valueMaps.map((m, i) => {
                            const v = m.get(trait.code) ?? null;
                            const isBest = best != null && v === best;
                            const rel = relMaps[i][trait.code];
                            return (
                              <td
                                key={bulls[i].usAnimalId}
                                title={typeof rel === "number" ? `Reliability ${rel}%` : undefined}
                                className={`px-3 py-2 tabular-nums ${isBest ? "bg-emerald-50 font-semibold text-emerald-800" : "text-slate-700"}`}
                              >
                                {fmt(trait, v)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Rows marked <span className="font-semibold">*</span> are shown but never ranked. Rump Angle, Stature,
            Rear Legs Side View, Rear Teat Placement and Teat Length have an <strong>intermediate optimum</strong> —
            neither the highest nor the lowest value is best, so highlighting one would point at the wrong bull.
            The body traits carry no single direction of merit and are left unranked for the same reason.
            {showsTpi && (
              <>
                {" "}<strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
                Association USA formula in force for each round. It is not an official Holstein Association USA
                publication and is typically within ±3 points. TPI is a registered trademark of Holstein
                Association USA. Udder and Feet &amp; Legs composites are calculated the same way.
              </>
            )}{" "}
            All values come from each bull&apos;s preferred <strong>official</strong> CDCB round — monthly and weekly
            adds are never compared. Yield figures are PTAs in <strong>pounds</strong>. Hover a value for its reliability.
          </p>
        </>
      )}
    </div>
  );
}

async function load(ids: string[]) {
  // Only official rows are authoritative, and isPreferred is already only ever set
  // on one — the runKind filter is belt and braces so a future change to the
  // preferred recompute cannot quietly admit a provisional monthly here.
  const officialPreferred = { isPreferred: true, runKind: "official", approvalStatus: "approved" };

  const rows =
    ids.length
      ? await prisma.usEvaluation.findMany({
          // THIS FILTERED ON `animalId` AND THAT WAS A BUG, not an inefficiency.
          // `animalId` is the OPTIONAL bridge to the Canadian Animal row and is
          // null for 68,581 of the 68,721 preferred bulls, while the picker emits
          // `usAnimalId`. So every id the picker produced matched nothing, and
          // this page returned an empty comparison for any bull that is not also
          // registered in Canada — which is virtually all of them. Verified
          // against production: `animalId: { in: [two real picker ids] }` returns
          // 0 rows, `usAnimalId` returns 2.
          where: { ...officialPreferred, usAnimalId: { in: ids } },
          select: {
            usAnimalId: true, id17: true, evalBreed: true, naabCode: true, roundCode: true, isPtaMilk: true,
            tpi: true, jpi: true, udc: true, flc: true, gptaJson: true, relJson: true,
            usAnimal: { select: { name: true, id17: true } },
          },
        })
      : [];

  // Preserve the order the bulls were listed in the URL.
  const byId = new Map(rows.map((r) => [r.usAnimalId, r]));
  const bulls = ids.map((id) => byId.get(id)).filter((b): b is (typeof rows)[number] => Boolean(b));

  // AI status is per round; take each bull's most recent one rather than pinning
  // a round, so a bull whose latest proof predates the current file still shows
  // the last status CDCB published for him.
  const aiRows = bulls.length
    ? await prisma.usAiStatus.findMany({
        where: { id17: { in: bulls.map((b) => b.id17) } },
        orderBy: { roundCode: "desc" },
        select: { id17: true, code: true },
      })
    : [];
  const aiByAnimal = new Map<string, string>();
  for (const r of aiRows) if (!aiByAnimal.has(r.id17)) aiByAnimal.set(r.id17, r.code);

  // "Nothing imported yet" and "you have not picked anyone" are different states
  // and must not share a message. This used to fall out of the picker list, which
  // no longer exists; one cached existence check replaces it rather than a count
  // over 68,721 rows on every view.
  const hasOfficialRound = await cached(
    "us:hasOfficialRound",
    async () => (await prisma.usEvaluation.findFirst({ where: officialPreferred, select: { usEvaluationId: true } })) != null,
  );

  return { bulls, aiByAnimal, hasOfficialRound };
}
