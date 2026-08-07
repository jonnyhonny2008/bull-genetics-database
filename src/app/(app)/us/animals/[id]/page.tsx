import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, StatCard, Badge, Table, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { US_KEY_TRAITS, formatUsTrait, type UsKeyTrait } from "@/lib/us-cdcb/key-traits";
import { cdcbRoundLabel } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// The American sire card.
//
// Reads UsEvaluation ONLY. The Canadian side is queried once, for a bare
// existence count, so the page can offer a link to /animals/[id] — not a single
// Canadian value is read or rendered here. A Lactanet EBV is in kilograms and a
// CDCB PTA is in pounds, so one leaking into an American column would be a
// silent factor-of-two error on a page people buy semen from.
//
// Only runKind='official' rows are shown. CDCB's monthly and weekly adds are
// provisional — every Ayrshire bull first published in Feb 2026 had a different
// GPTA by the April round — so they are counted and named but never rendered as
// a proof or ranked beside a round.
// ---------------------------------------------------------------------------

const GTPI_DISCLAIMER =
  "Calculated by Blondin Sires from CDCB evaluations using the Holstein Association USA formula in force " +
  "for each round. Not an official Holstein Association USA publication. Typically within ±3 points. " +
  "TPI is a registered trademark of Holstein Association USA.";

export default async function UsSireCard({ params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  const animal = await prisma.animal.findFirst({
    where: { id: params.id, archived: false },
    select: { id: true, primaryName: true, sex: true, birthDate: true, breed: { select: { breedName: true } } },
  });
  if (!animal) notFound();

  // Existence only — never values. The two sides must be navigable without one
  // ever borrowing the other's numbers.
  const canadianRounds = await prisma.geneticEvaluation.count({
    where: { animalId: animal.id, approvalStatus: "approved" },
  });

  let us: UsData = { rounds: [], betweenRoundRows: 0, aiStatus: null, missingTables: false };
  try {
    us = await loadUs(animal.id);
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run this is a
    // setup state, not a fault — say so rather than rendering a 500.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) {
      us.missingTables = true;
    } else throw e;
  }

  // The preferred row is recomputed by recomputeUsPreferred() over official rows
  // only. Falling back to the newest round keeps the card working for an animal
  // imported before that recompute ran.
  const pref = us.rounds.find((r) => r.isPreferred) ?? us.rounds[0] ?? null;

  const backLinks = (
    <>
      <Link href="/us/animals" className="btn-secondary btn-sm">‹ American lineup</Link>
      {canadianRounds > 0 && (
        <Link href={`/animals/${animal.id}`} className="btn-secondary btn-sm" title="The same animal on the Canadian side — EBVs in kilograms">
          Canadian page ({canadianRounds} round{canadianRounds === 1 ? "" : "s"})
        </Link>
      )}
    </>
  );

  if (us.missingTables) {
    return (
      <div>
        <PageHeader title={animal.primaryName} subtitle="CDCB evaluation" actions={backLinks} />
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run db:push:prod</pre>
          <p className="mt-3 text-sm text-slate-600">Then import a CDCB round:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      </div>
    );
  }

  if (!pref) {
    return (
      <div>
        <PageHeader title={animal.primaryName} subtitle="No CDCB evaluation" actions={backLinks} />
        <EmptyState message="This animal has no official CDCB round on file.">
          <div className="space-y-2 text-xs text-slate-500">
            {us.betweenRoundRows > 0 && (
              <p>
                He does carry {us.betweenRoundRows} between-round CDCB row{us.betweenRoundRows === 1 ? "" : "s"} —
                a monthly or weekly add. Those values are provisional and are superseded at the next official
                round, so they are not shown as a proof.
              </p>
            )}
            <p>
              A US evaluation appears here once a CDCB round is imported that contains him, or once his
              Canadian registration is matched to a CDCB id.
            </p>
          </div>
        </EmptyState>
      </div>
    );
  }

  const gpta = parseMap(pref.gptaJson);
  const rel = parseMap(pref.relJson);
  const dgv = parseMap(pref.dgvJson);
  const pa = parseMap(pref.paJson);
  const haplotypes = parseStringMap(pref.haplotypesJson);
  const groups = groupTraits(gpta, dgv, pa);
  const isJersey = pref.evalBreed === "JE";

  return (
    <div>
      <PageHeader
        title={animal.primaryName}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {pref.naabCode && <span className="font-mono text-xs text-slate-600">NAAB {pref.naabCode}</span>}
            <span>{pref.evalBreed ?? animal.breed?.breedName ?? "breed not stated"}</span>
            <span>born {fmtDate(animal.birthDate)}</span>
            <Badge tone="blue">{roundLabel(pref.roundCode)} · official</Badge>
            {us.aiStatus && <Badge tone="brand">{AI_STATUS_LABELS[us.aiStatus] ?? us.aiStatus}</Badge>}
          </span>
        }
        actions={backLinks}
      />

      {/* --- The big numbers ------------------------------------------------ */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {isJersey ? (
          <StatCard
            label="JPI (calc.)"
            value={pref.jpi ?? "—"}
            hint={pref.jpiFormulaVersion ? `${pref.jpiFormulaVersion} formula` : "not computable for this round"}
            tone="accent"
          />
        ) : (
          <StatCard
            label="GTPI (calc.)"
            value={pref.tpi ?? "—"}
            hint={pref.tpiFormulaVersion ? `${pref.tpiFormulaVersion} formula` : "formula not verified for this round"}
            tone="accent"
          />
        )}
        <StatCard label="Net Merit" value={pref.nmDollar == null ? "—" : `$${Math.round(pref.nmDollar)}`} hint="CDCB published, in dollars" />
        <StatCard label="PTAT" value={pref.ptat == null ? "—" : pref.ptat.toFixed(2)} hint="CDCB published type" />
        <StatCard
          label="Production basis"
          value={pref.isPtaMilk === true ? "Daughters" : pref.isPtaMilk === false ? "Parent avg" : "—"}
          hint={pref.isPtaMilk === true ? "real daughter-based PTA" : pref.isPtaMilk === false ? "no daughters yet" : "not stated"}
          tone={pref.isPtaMilk === true ? "good" : "default"}
        />
      </div>

      {/* --- The seven lead traits ------------------------------------------ */}
      <Card title="US key traits" className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {US_KEY_TRAITS.map((t) => (
            <div key={t.code} className="rounded-md border border-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t.short}</div>
              <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{keyTraitValue(t, pref)}</div>
              <div className="mt-1 text-[11px] leading-tight text-slate-400">
                {t.direction === "intermediate" ? (
                  <span className="font-medium text-amber-700">Intermediate optimum — not ranked</span>
                ) : t.source === "computed" ? (
                  "calculated, not published"
                ) : (
                  `reliability ${rel[t.code] != null ? `${rel[t.code]}%` : "—"}`
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Rump Angle has an <strong>intermediate optimum</strong>: neither the highest nor the lowest value is
          the best one, so it is shown but never sorted, ranked or scored as higher-is-better. Every yield
          figure is a PTA in <strong>pounds</strong>.
        </p>
      </Card>

      {/* --- What kind of proof this is ------------------------------------- */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Proven or genomic">
          <dl className="space-y-2 text-sm">
            <Row k="Production (IS_PTA_MILK)" v={pref.isPtaMilk === true ? "Daughter-based PTA" : pref.isPtaMilk === false ? "Parent average" : "not stated"} />
            <Row k="Calving (IS_PTA_CT)" v={pref.isPtaCt === true ? "Daughter-based PTA" : pref.isPtaCt === false ? "Parent average" : "not stated"} />
            <Row k="Blend code" v={pref.blendCode === "S" ? "S — straightbred" : pref.blendCode === "M" ? "M — crossbred" : pref.blendCode ?? "—"} />
            <Row k="Genotyping chip" v={pref.chip ?? "—"} />
            <Row k="Evaluation date" v={fmtDate(pref.evaluationDate)} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            CDCB answers proven-vs-genomic <strong>per trait group, not per animal</strong>. A bull can be
            daughter-proven for production and still carry a parent average for calving, so the two flags are
            read separately and neither one describes the whole evaluation.
          </p>
        </Card>

        <Card title="Inbreeding">
          <dl className="space-y-2 text-sm">
            <Row k="Genomic (GEN_INB)" v={pct(pref.genInb)} />
            <Row k="Pedigree (PED_INB)" v={pct(pref.pedInb)} />
            <Row k="Genomic future (GEN_FUT_INB)" v={pct(pref.genFutInb)} />
            <Row k="Expected future (EXP_FUT_INB)" v={pct(pref.expFutInb)} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            These are four different measures and must not be averaged or compared with each other. The first
            two are <em>this animal&rsquo;s own</em> inbreeding — one read from his genotype, one from his
            recorded pedigree. The last two are forward-looking: the inbreeding expected in his progeny from
            matings to the current population, again genomic and pedigree respectively.
          </p>
        </Card>
      </div>

      {/* --- Round history --------------------------------------------------- */}
      <Card title="US round history" className="mb-4">
        {us.rounds.length === 1 ? (
          <p className="text-sm text-slate-600">
            One official round on file ({roundLabel(pref.roundCode)}). Movement becomes visible from the second
            round onward.
          </p>
        ) : (
          <Table
            head={
              <>
                <th className="th">Round</th>
                <th className="th text-right">{isJersey ? "JPI (calc.)" : "GTPI (calc.)"}</th>
                <th className="th text-right">NM$</th>
                <th className="th text-right">PTAT</th>
                <th className="th">Production</th>
                <th className="th">Formula</th>
              </>
            }
          >
            {us.rounds.map((r, i) => {
              const older = us.rounds[i + 1];
              const idx = isJersey ? r.jpi : r.tpi;
              const olderIdx = isJersey ? older?.jpi : older?.tpi;
              const version = isJersey ? r.jpiFormulaVersion : r.tpiFormulaVersion;
              const olderVersion = isJersey ? older?.jpiFormulaVersion : older?.tpiFormulaVersion;
              // A calculated index is only comparable to itself. When the formula
              // version changed between two rounds the difference is partly the
              // formula moving, not the bull, so no delta is offered at all.
              const sameFormula = !!older && !!version && version === olderVersion;
              return (
                <tr key={r.usEvaluationId} className="hover:bg-slate-50">
                  <td className="td">
                    <span className="font-medium">{roundLabel(r.roundCode)}</span>
                    {r.isPreferred && <span className="ml-2 align-middle"><Badge tone="green">shown above</Badge></span>}
                    {r.isGraduation && <span className="ml-2 align-middle"><Badge tone="amber">graduation</Badge></span>}
                  </td>
                  <Cell value={idx == null ? "—" : String(idx)} delta={sameFormula ? delta(idx, olderIdx, 0) : null} />
                  <Cell value={r.nmDollar == null ? "—" : `$${Math.round(r.nmDollar)}`} delta={delta(r.nmDollar, older?.nmDollar, 0)} />
                  <Cell value={r.ptat == null ? "—" : r.ptat.toFixed(2)} delta={delta(r.ptat, older?.ptat, 2)} />
                  <td className="td text-xs text-slate-500">{r.isPtaMilk === true ? "daughters" : r.isPtaMilk === false ? "parent avg" : "—"}</td>
                  <td className="td text-xs text-slate-500">{version ?? "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Official rounds only — CDCB ships one file per round, so there is no interim proof to compare
          against. Differences are raw arithmetic between published figures: CDCB re-bases roughly every five
          years (most recently at the April 2025 round) and every animal&rsquo;s values shift at a re-basing,
          so a change that spans one is not genetic movement. A graduation round — a genomic bull&rsquo;s first
          daughter proof — moves several times a normal round and should be read as a change of evaluation
          type, not as a drop.
          {us.betweenRoundRows > 0 && (
            <> This animal also has {us.betweenRoundRows} provisional between-round row
              {us.betweenRoundRows === 1 ? "" : "s"}, which are excluded here.</>
          )}
        </p>
      </Card>

      {/* --- Everything CDCB publishes for him ------------------------------- */}
      <Card title="Every published trait" className="mb-4">
        <p className="mb-3 text-xs text-slate-500">
          <strong>GPTA</strong> is the published evaluation — the number to quote. <strong>Rel.</strong> is its
          reliability, where CDCB publishes one. <strong>DGV</strong> is the direct genomic value, the genomic
          prediction alone before blending with pedigree and daughter information. <strong>PA</strong> is the
          parent average, what the pedigree alone predicted. The seven lead traits appear above as well; they
          are repeated here so their reliability and PA are visible alongside the rest.
        </p>
        {groups.map((g) => (
          <div key={g.group} className="mb-4 last:mb-0">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.group}</h3>
            <Table
              head={
                <>
                  <th className="th">Trait</th>
                  <th className="th text-right">GPTA</th>
                  <th className="th text-right">Rel.</th>
                  <th className="th text-right">DGV</th>
                  <th className="th text-right">PA</th>
                </>
              }
            >
              {g.rows.map((t) => (
                <tr key={t.code} className="hover:bg-slate-50">
                  <td className="td">
                    <span className="font-medium">{t.def.label}</span>
                    <span className="ml-2 font-mono text-[10px] text-slate-400">{t.code}</span>
                    {t.def.direction === "intermediate" && (
                      <span className="ml-2 align-middle"><Badge tone="amber">intermediate optimum</Badge></span>
                    )}
                    {t.def.direction === "lower" && (
                      <span className="ml-2 align-middle"><Badge>lower is better</Badge></span>
                    )}
                  </td>
                  <td className="td text-right font-semibold tabular-nums">{fmtTrait(t.def, gpta[t.code])}</td>
                  <td className="td text-right tabular-nums text-slate-500">{rel[t.code] != null ? `${rel[t.code]}%` : "—"}</td>
                  <td className="td text-right tabular-nums text-slate-600">{fmtTrait(t.def, dgv[t.code])}</td>
                  <td className="td text-right tabular-nums text-slate-600">{fmtTrait(t.def, pa[t.code])}</td>
                </tr>
              ))}
            </Table>
          </div>
        ))}
        <p className="mt-3 text-xs text-slate-500">
          CDCB publishes a fifth column, GSONS, which this app stores but does not show. It is the genomic
          evaluation for producing <em>sons</em>, with X-chromosome effects excluded — the correct input when
          computing a son&rsquo;s parent average, and emphatically not a count of sons.
        </p>
      </Card>

      {/* --- Haplotypes ------------------------------------------------------ */}
      <Card title="Haplotypes and genetic conditions" className="mb-4">
        {Object.keys(haplotypes).length === 0 ? (
          <p className="text-sm text-slate-600">
            CDCB published no haplotype or genetic-condition call for this animal in the{" "}
            {roundLabel(pref.roundCode)} round. That is an absence of a call, not a clear result.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {Object.entries(haplotypes).map(([code, value]) => (
                <span key={code} className="rounded-md border border-slate-200 px-2.5 py-1.5 text-sm">
                  <span className="font-mono text-xs font-semibold text-slate-700">{code}</span>
                  <span className="ml-2 tabular-nums text-slate-900">{value}</span>
                </span>
              ))}
            </div>
            {/* Codes are shown exactly as CDCB ships them, deliberately. A carrier
                status drives real mating decisions, and inventing a "carrier"/"free"
                translation for a code we have not verified against CDCB's own
                documentation would be a confident wrong answer in the one place
                that cannot afford it. */}
            <p className="mt-3 text-xs text-slate-500">
              Shown exactly as CDCB publishes them — the raw code and the raw call, with no re-interpretation
              by this app. Read them against CDCB&rsquo;s genetic-condition documentation for the round before
              acting on any of them.
            </p>
          </>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        <strong>{isJersey ? "JPI" : "GTPI"} is calculated</strong>, not published.{" "}
        {isJersey
          ? "It is computed by Blondin Sires from CDCB evaluations using the American Jersey Cattle Association formula in force for each round, and is not an official AJCA publication. AJCA does not publish JPI for crossbreds."
          : GTPI_DISCLAIMER}{" "}
        Every value on this page is a CDCB PTA in <strong>pounds</strong> — roughly half the corresponding
        Canadian breeding value, and never directly comparable to one.
      </p>
    </div>
  );
}

// --- Data -------------------------------------------------------------------

interface UsData {
  rounds: UsRound[];
  /** Monthly and weekly adds. Counted so the page can say they exist, never shown. */
  betweenRoundRows: number;
  aiStatus: string | null;
  missingTables: boolean;
}

type UsRound = Awaited<ReturnType<typeof loadRounds>>[number];

function loadRounds(animalId: string) {
  return prisma.usEvaluation.findMany({
    where: { animalId, runKind: "official", approvalStatus: "approved" },
    orderBy: { evaluationDate: "desc" },
    select: {
      usEvaluationId: true, roundCode: true, evaluationDate: true, evalBreed: true, naabCode: true,
      isPreferred: true, isGraduation: true, isPtaMilk: true, isPtaCt: true, blendCode: true, chip: true,
      genInb: true, pedInb: true, genFutInb: true, expFutInb: true,
      nmDollar: true, ptat: true, tpi: true, tpiFormulaVersion: true, jpi: true, jpiFormulaVersion: true,
      milk: true, rpa: true, dpr: true, ccr: true,
      gptaJson: true, relJson: true, dgvJson: true, paJson: true, haplotypesJson: true,
    },
  });
}

async function loadUs(animalId: string): Promise<UsData> {
  const [rounds, betweenRoundRows] = await Promise.all([
    loadRounds(animalId),
    prisma.usEvaluation.count({ where: { animalId, runKind: { not: "official" } } }),
  ]);
  // CDCB's AI-status file is the US answer to "is this bull actually marketed" —
  // carrying a NAAB code is not that answer. It is keyed on the round, so it is
  // only meaningful next to the round being shown.
  const roundCode = rounds.find((r) => r.isPreferred)?.roundCode ?? rounds[0]?.roundCode ?? null;
  const status = roundCode
    ? await prisma.usAiStatus.findFirst({ where: { animalId, roundCode }, select: { code: true } })
    : null;
  return { rounds, betweenRoundRows, aiStatus: status?.code ?? null, missingTables: false };
}

const AI_STATUS_LABELS: Record<string, string> = {
  A: "Active AI",
  G: "Genomic young bull, marketed",
  F: "Foreign",
};

// --- Trait catalogue --------------------------------------------------------
// CDCB ships trait CODES and nothing else — no labels, no units, no direction.
// This is the display dictionary for them. Only codes whose meaning is confirmed
// in this repo's own verified sources (index-registry.ts, jpi.ts, the CDCB
// fixtures) carry a label; anything else falls through to "Other published
// traits" and is shown under its raw code rather than under a guess.
//
// `direction` exists so the page can warn where "more is better" is false. Two
// of the intermediate flags are not opinion: UDC penalises |TLG| and FLC
// penalises |RLS| on BOTH sides of zero (see index-registry.ts), and AJCA scores
// udder depth as distance from an optimum (see jpi.ts), so those traits are
// demonstrably two-way in the arithmetic this app already trusts.

interface UsTraitDef {
  label: string;
  group: string;
  /** "$" prefixes, "%" suffixes, anything else is a suffixed unit word. */
  unit?: string;
  decimals: number;
  /** False for traits published on an absolute scale, where a "+" would be wrong. */
  signed: boolean;
  direction: "higher" | "lower" | "intermediate";
}

const MERIT = "Merit indexes", PROD = "Production", FERT = "Fertility";
const HEALTH = "Health and longevity", CALV = "Calving", FEED = "Feed", TYPE = "Type";
const LINEAR = "Type — linear", OTHER = "Other published traits";

const d = (label: string, group: string, decimals: number, opts: Partial<UsTraitDef> = {}): UsTraitDef => ({
  label, group, decimals, signed: true, direction: "higher", ...opts,
});

const US_TRAITS: Record<string, UsTraitDef> = {
  NM: d("Net Merit", MERIT, 0, { unit: "$" }),
  CM: d("Cheese Merit", MERIT, 0, { unit: "$" }),
  FM: d("Fluid Merit", MERIT, 0, { unit: "$" }),
  GM: d("Grazing Merit", MERIT, 0, { unit: "$" }),

  MILK: d("Milk", PROD, 0, { unit: "lb" }),
  FAT: d("Fat", PROD, 0, { unit: "lb" }),
  PRO: d("Protein", PROD, 0, { unit: "lb" }),
  FATPCT: d("Fat percent", PROD, 2, { unit: "%" }),
  PROPCT: d("Protein percent", PROD, 2, { unit: "%" }),

  DPR: d("Daughter Pregnancy Rate", FERT, 1, { unit: "%" }),
  HCR: d("Heifer Conception Rate", FERT, 1, { unit: "%" }),
  CCR: d("Cow Conception Rate", FERT, 1, { unit: "%" }),
  EFC: d("Early First Calving", FERT, 1),
  GL: d("Gestation Length", FERT, 1),

  PL: d("Productive Life", HEALTH, 1),
  LIV: d("Livability", HEALTH, 1, { unit: "%" }),
  HLV: d("Heifer Livability", HEALTH, 1, { unit: "%" }),
  // SCS is published on an absolute scale around 3.0, not as a deviation, so it
  // takes no sign — and lower is better.
  SCS: d("Somatic Cell Score", HEALTH, 2, { signed: false, direction: "lower" }),
  MFV: d("Milk Fever", HEALTH, 1, { unit: "%" }),
  DAB: d("Displaced Abomasum", HEALTH, 1, { unit: "%" }),
  KET: d("Ketosis", HEALTH, 1, { unit: "%" }),
  MAS: d("Mastitis", HEALTH, 1, { unit: "%" }),
  MET: d("Metritis", HEALTH, 1, { unit: "%" }),
  RPL: d("Retained Placenta", HEALTH, 1, { unit: "%" }),

  // Calving traits are published as a percentage of births, absolute and
  // lower-is-better — an unsigned scale where "+7%" would misread as a gain.
  SCE: d("Sire Calving Ease", CALV, 1, { unit: "%", signed: false, direction: "lower" }),
  DCE: d("Daughter Calving Ease", CALV, 1, { unit: "%", signed: false, direction: "lower" }),
  SSB: d("Sire Stillbirth", CALV, 1, { unit: "%", signed: false, direction: "lower" }),
  DSB: d("Daughter Stillbirth", CALV, 1, { unit: "%", signed: false, direction: "lower" }),

  FS: d("Feed Saved", FEED, 0, { unit: "lb" }),
  RFI: d("Residual Feed Intake", FEED, 0, { unit: "lb" }),

  PTAT: d("Type (PTAT)", TYPE, 2),

  STA: d("Stature", LINEAR, 2),
  STR: d("Strength", LINEAR, 2),
  BDE: d("Body Depth", LINEAR, 2),
  DFM: d("Dairy Form", LINEAR, 2),
  RPA: d("Rump Angle", LINEAR, 2, { direction: "intermediate" }),
  TRW: d("Thurl Width", LINEAR, 2),
  RLS: d("Rear Legs, side view", LINEAR, 2, { direction: "intermediate" }),
  RLR: d("Rear Legs, rear view", LINEAR, 2),
  FTA: d("Foot Angle", LINEAR, 2),
  FLS: d("Feet and Legs Score", LINEAR, 2),
  FUA: d("Fore Udder Attachment", LINEAR, 2),
  RUH: d("Rear Udder Height", LINEAR, 2),
  RUW: d("Rear Udder Width", LINEAR, 2),
  UCL: d("Udder Cleft", LINEAR, 2),
  UDP: d("Udder Depth", LINEAR, 2, { direction: "intermediate" }),
  FTP: d("Front Teat Placement", LINEAR, 2),
  RTP: d("Rear Teat Placement", LINEAR, 2),
  TLG: d("Teat Length", LINEAR, 2, { direction: "intermediate" }),
};

const GROUP_ORDER = [MERIT, PROD, FERT, HEALTH, CALV, FEED, TYPE, LINEAR, OTHER];

/** The catalogue order within a group, so a group reads the way it was written. */
const CATALOGUE_ORDER = Object.keys(US_TRAITS);

function groupTraits(gpta: NumMap, dgv: NumMap, pa: NumMap) {
  // The union, not just gptaJson: a trait can carry a parent average with no
  // published GPTA yet, and dropping it would hide that the animal has one.
  const codes = [...new Set([...Object.keys(gpta), ...Object.keys(dgv), ...Object.keys(pa)])];
  const byGroup = new Map<string, { code: string; def: UsTraitDef }[]>();
  for (const code of codes) {
    const def = US_TRAITS[code] ?? { label: code, group: OTHER, decimals: 2, signed: true, direction: "higher" as const };
    const arr = byGroup.get(def.group) ?? [];
    arr.push({ code, def });
    byGroup.set(def.group, arr);
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((group) => ({
    group,
    rows: (byGroup.get(group) ?? []).sort((x, y) => {
      const ix = CATALOGUE_ORDER.indexOf(x.code), iy = CATALOGUE_ORDER.indexOf(y.code);
      return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || x.code.localeCompare(y.code);
    }),
  }));
}

// --- Formatting -------------------------------------------------------------

type NumMap = Record<string, number>;

function parseMap(json: string | null): NumMap {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: NumMap = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function parseStringMap(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (v != null && v !== "") out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

function fmtTrait(def: UsTraitDef, v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(def.decimals);
  const signed = def.signed && v > 0 ? `+${s}` : s;
  if (def.unit === "$") return `$${signed}`;
  if (def.unit === "%") return `${signed}%`;
  return def.unit ? `${signed} ${def.unit}` : signed;
}

/** The key-trait block reads the indexed columns, not the JSON — same values,
 *  and it keeps this page agreeing with the lineup's sort order exactly. */
function keyTraitValue(t: UsKeyTrait, r: UsRound): string {
  const v = r[t.column] as number | null;
  if (t.code === "GTPI") return r.tpi == null ? "—" : String(r.tpi);
  return formatUsTrait(t, v);
}

function delta(cur: number | null | undefined, prev: number | null | undefined, decimals: number): string | null {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < 0.005) return "no change";
  return `${diff > 0 ? "+" : ""}${diff.toFixed(decimals)}`;
}

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);

/** cdcbRoundLabel wants a classified file; a round code is all we store, so feed
 *  it the one field it reads. */
function roundLabel(roundCode: string | null): string {
  if (!roundCode) return "—";
  return cdcbRoundLabel({ family: null, kind: null, breed: null, roundCode, periodKey: null, date: roundCode }) ?? roundCode;
}

// --- Small presentational pieces --------------------------------------------

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5 last:border-0">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-medium text-slate-800">{v}</dd>
    </div>
  );
}

function Cell({ value, delta: change }: { value: string; delta: string | null }) {
  return (
    <td className="td text-right tabular-nums">
      <div className="font-semibold">{value}</div>
      {change && (
        <div className={`text-[11px] ${change.startsWith("+") ? "text-emerald-600" : change.startsWith("-") ? "text-red-600" : "text-slate-400"}`}>
          {change}
        </div>
      )}
    </td>
  );
}
