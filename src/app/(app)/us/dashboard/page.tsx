import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { PageHeader, Card, StatCard, Badge, Table, EmptyState } from "@/components/ui";
import { fmtNum, relTime } from "@/lib/format";
import { INDEX_REGISTRY, resolveTpiFormula, formulaConfidence } from "@/lib/us-cdcb/index-registry";
import { JPI_REGISTRY, resolveJpiFormula } from "@/lib/us-cdcb/jpi";
import { CDCB_BREEDS, cdcbRoundLabel, cdcbRunKindLabel } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// The American landing page.
//
// It has TWO faces, and which one shows is decided by whether a CDCB round has
// actually been imported:
//
//   * Data on file  — the lineup itself: how many bulls, on which round, split by
//     breed / proven-vs-genomic / AI status, who is at the top by GTPI and by
//     Net Merit, and what the importer last wrote.
//   * Nothing on file — what the ENGINE is ready to do. This is the original
//     content of this page and it stays, deliberately: a dashboard reading "0
//     bulls · avg GTPI —" looks like an import that ran and failed, when the truth
//     is that it has not been run. An un-run importer and a broken one must not
//     render the same.
//
// Reads UsEvaluation ONLY — never GeneticEvaluation, whose values are EBVs in
// kilograms rather than PTAs in pounds.
// ---------------------------------------------------------------------------

/** The round the formula registry is current for. Used ONLY by the empty state —
 *  once rows exist the round comes from the database, never from this constant. */
const CURRENT_ROUND = "2604";

/** Bounds the top-list queries. Nothing here scans the whole lineup. */
const TOP_N = 10;

export default async function UsDashboardPage() {
  const user = currentUser();
  if (!user) redirect("/login");

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let missingTables = false;
  try {
    data = await load();
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, say so
    // plainly rather than rendering a 500 — this is a setup state, not a fault.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) missingTables = true;
    else throw e;
  }

  if (missingTables) return <SetupState />;
  if (!data || data.total === 0) return <EngineReadyState />;

  const { total, rounds, currentRound, breeds, proven, genomic, unstated, ai, topTpi, topNm, imports } = data;
  const tpi = resolveTpiFormula(currentRound ?? CURRENT_ROUND);

  return (
    <div>
      <PageHeader
        title="American genetics"
        subtitle={
          <span>
            CDCB evaluations — PTAs in pounds, published April / August / December.{" "}
            <Badge tone="blue">{roundLabel(currentRound)}</Badge>
          </span>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Bulls in lineup" value={fmtNum(total)} tone="good" hint="preferred official round" href="/us/animals" />
        <StatCard label="Evaluation round" value={roundLabel(currentRound)} hint={`${fmtNum(rounds.length)} official round${rounds.length === 1 ? "" : "s"} on file`} />
        <StatCard label="Daughter-proven (milk)" value={fmtNum(proven)} hint={`${fmtNum(genomic)} genomic · ${fmtNum(unstated)} unstated`} />
        <StatCard label="Active AI" value={ai ? fmtNum(ai.A) : "—"} tone="accent" hint={ai ? `${fmtNum(ai.G)} marketed young · ${fmtNum(ai.F)} foreign` : "no AI-status file imported"} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="By breed">
          <Table head={<>
            <th className="th">Breed</th>
            <th className="th text-right">Bulls</th>
            <th className="th text-right" title="Daughter-proven for the production traits">Proven</th>
            <th className="th text-right">Avg NM$</th>
            <th className="th text-right">Avg GTPI</th>
          </>}>
            {breeds.map((b) => (
              <tr key={b.code}>
                <td className="td font-medium">{b.code}</td>
                <td className="td text-right tabular-nums">{fmtNum(b.n)}</td>
                <td className="td text-right tabular-nums text-slate-500">{fmtNum(b.proven)}</td>
                <td className="td text-right tabular-nums">{b.avgNm == null ? "—" : `$${Math.round(b.avgNm)}`}</td>
                <td className="td text-right tabular-nums">{b.avgTpi == null ? "—" : Math.round(b.avgTpi)}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-[11px] text-slate-500">
            Breed is CDCB&rsquo;s EVAL_BREED — the breed the animal was <em>evaluated</em> in, not the registry
            prefix on its id. GTPI is only computed for Holsteins and JPI only for Jerseys, so the other
            breeds carry no index average.
          </p>
        </Card>

        <Card title="AI status (CDCB status file)">
          {!ai ? (
            <EmptyState message="No AI-status file has been imported for this round, so nothing here can say which bulls are actually being marketed." />
          ) : (
            <>
              <div className="space-y-2 text-sm">
                <Bar label="A — active AI" value={ai.A} total={ai.total} tone="bg-brand-500" />
                <Bar label="G — genomic young bull, marketed" value={ai.G} total={ai.total} tone="bg-purple-500" />
                <Bar label="F — foreign" value={ai.F} total={ai.total} tone="bg-amber-500" />
              </div>
              <p className="mt-3 text-[11px] text-slate-500">
                Round {ai.roundCode}, counted over the bulls in this lineup rather than over the file, so these
                are this stud&rsquo;s numbers and not CDCB&rsquo;s population. <strong>Active is not the same thing
                as carrying a NAAB code</strong> — on this side it is whatever the status file says, which is the
                only statement CDCB makes about whether a bull is actually being sold.
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={`Top ${TOP_N} by GTPI (calculated)`}>
          {topTpi.length === 0 ? (
            <EmptyState message="GTPI is computed for Holsteins only, and no Holstein round is loaded." />
          ) : (
            <TopTable rows={topTpi} valueLabel="GTPI" />
          )}
        </Card>

        <Card title={`Top ${TOP_N} by Net Merit`}>
          {topNm.length === 0 ? (
            <EmptyState message="No Net Merit values on the current round." />
          ) : (
            <TopTable rows={topNm} valueLabel="NM$" />
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Recent import activity">
          {imports.length === 0 ? (
            <EmptyState message="No source file is recorded against any evaluation." />
          ) : (
            <Table head={<>
              <th className="th">Source file</th>
              <th className="th">Kind</th>
              <th className="th text-right">Rows</th>
              <th className="th text-right">Imported</th>
            </>}>
              {imports.map((f) => (
                <tr key={`${f.sourceFile}|${f.runKind}`}>
                  <td className="td font-mono text-[11px] text-slate-600">{f.sourceFile}</td>
                  <td className="td">
                    <Badge tone={f.runKind === "official" ? "green" : f.runKind === "provisional" ? "amber" : "slate"}>
                      {cdcbRunKindLabel(f.runKind as "official" | "provisional" | "unofficial")}
                    </Badge>
                  </td>
                  <td className="td text-right tabular-nums">{fmtNum(f.rows)}</td>
                  <td className="td text-right text-xs text-slate-500">{relTime(f.at)}</td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            Every evaluation carries the file it came from. Only <strong>official</strong> rows are authoritative —
            provisional (monthly) and unofficial (weekly) adds are stored and dated but are never counted as a
            round or ranked alongside one.
          </p>
        </Card>

        <Card title={`Holstein TPI formula · ${roundLabel(currentRound)}`}>
          <dl className="space-y-2 text-sm">
            <Row k="Formula in force" v={`${tpi.tpi.label} (constant ${tpi.tpi.constant})`} />
            <Row k="Feed Efficiency" v={tpi.fe?.label ?? "—"} />
            <Row k="Fertility Index" v={tpi.fi?.label ?? "—"} />
            <Row k="Health Trait Index" v={tpi.ht?.label ?? "—"} />
            <Row k="Composites" v={`${tpi.udc?.label ?? "—"} · ${tpi.flc?.label ?? "—"}`} />
            <Row k="Confidence" v={formulaConfidence(tpi)} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
            Association USA formula in force for each round. It is not an official Holstein Association USA
            publication and is typically within ±3 points of the published figure, so it is shown as a whole
            number throughout. TPI is a registered trademark of Holstein Association USA.
          </p>
        </Card>
      </div>

      <DifferencesCard />
    </div>
  );
}

// --- data --------------------------------------------------------------------

async function load() {
  // Only official rows are authoritative. isPreferred is already only ever set on
  // an official row, but the runKind filter is stated anyway so a future change to
  // the preferred recompute cannot quietly admit a provisional monthly here.
  const officialPreferred: Prisma.UsEvaluationWhereInput = {
    isPreferred: true, runKind: "official", approvalStatus: "approved",
  };
  const topSelect = {
    usEvaluationId: true, usAnimalId: true, evalBreed: true, naabCode: true,
    tpi: true, tpiFormulaVersion: true, nmDollar: true, ptat: true,
    usAnimal: { select: { name: true, id17: true } },
  } as const;

  const [total, roundGroups, breedGroups, provenGroups, topTpi, topNm, fileGroups] = await Promise.all([
    prisma.usEvaluation.count({ where: officialPreferred }),
    prisma.usEvaluation.groupBy({
      by: ["roundCode"],
      where: { runKind: "official", approvalStatus: "approved", roundCode: { not: null } },
      _count: { _all: true },
    }),
    prisma.usEvaluation.groupBy({
      by: ["evalBreed"],
      where: officialPreferred,
      _count: { _all: true },
      _avg: { tpi: true, nmDollar: true },
    }),
    prisma.usEvaluation.groupBy({
      by: ["evalBreed", "isPtaMilk"],
      where: officialPreferred,
      _count: { _all: true },
    }),
    prisma.usEvaluation.findMany({
      where: { ...officialPreferred, tpi: { not: null } },
      orderBy: { tpi: "desc" }, take: TOP_N, select: topSelect,
    }),
    prisma.usEvaluation.findMany({
      where: { ...officialPreferred, nmDollar: { not: null } },
      orderBy: { nmDollar: "desc" }, take: TOP_N, select: topSelect,
    }),
    // Import activity is read off the rows themselves — there is no US import log.
    // Grouping by (file, kind) rather than by round is what answers "what did the
    // importer last write", which is a different question from "what rounds exist".
    prisma.usEvaluation.groupBy({
      by: ["sourceFile", "runKind"],
      where: { sourceFile: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);

  const rounds = roundGroups
    .map((g) => ({ roundCode: g.roundCode as string, n: g._count._all }))
    .sort((a, b) => b.roundCode.localeCompare(a.roundCode));
  const currentRound = rounds[0]?.roundCode ?? null;

  // Proven counts come from the (breed, isPtaMilk) grouping so the breed table and
  // the headline tile can never disagree about what "proven" means. isPtaMilk is
  // CDCB's flag for the PRODUCTION trait group specifically, not a property of the
  // bull — a sire can be daughter-proven for yield and still parent-average for
  // calving traits — so it is labelled as the production answer, not as "proven".
  const provenByBreed = new Map<string, number>();
  let proven = 0, genomic = 0, unstated = 0;
  for (const g of provenGroups) {
    const n = g._count._all;
    const breed = g.evalBreed ?? "—";
    if (g.isPtaMilk === true) {
      proven += n;
      provenByBreed.set(breed, (provenByBreed.get(breed) ?? 0) + n);
    } else if (g.isPtaMilk === false) genomic += n;
    else unstated += n;
  }

  // Order the breed table by CDCB's own breed list so it reads the same way every
  // round, with anything unrecognised (or unstated) after it.
  const breeds = breedGroups
    .map((g) => ({
      code: g.evalBreed ?? "—",
      n: g._count._all,
      proven: provenByBreed.get(g.evalBreed ?? "—") ?? 0,
      avgTpi: g._avg.tpi,
      avgNm: g._avg.nmDollar,
    }))
    .sort((a, b) => {
      const ia = CDCB_BREEDS.indexOf(a.code), ib = CDCB_BREEDS.indexOf(b.code);
      if (ia !== ib) return (ia < 0 ? CDCB_BREEDS.length : ia) - (ib < 0 ? CDCB_BREEDS.length : ib);
      return b.n - a.n;
    });

  const imports = fileGroups
    .map((g) => ({ sourceFile: g.sourceFile as string, runKind: g.runKind, rows: g._count._all, at: g._max.createdAt }))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, 8);

  // Deliberately sequential: the status file is per round, so which round to ask
  // about is only known once the rounds above have come back.
  const ai = currentRound ? await loadAiStatus(currentRound) : null;

  return { total, rounds, currentRound, breeds, proven, genomic, unstated, topTpi, topNm, imports, ai };
}

interface AiCounts { roundCode: string; A: number; G: number; F: number; total: number }

/**
 * AI status for a round, counted over THIS lineup.
 *
 * The status file is round-scoped and about 5% of its entries match no animal we
 * hold, so the counts are joined through the animal to the lineup rather than
 * taken from the file wholesale — otherwise the totals would describe CDCB's
 * population rather than this stud's.
 */
async function loadAiStatus(roundCode: string): Promise<AiCounts | null> {
  const groups = await prisma.usAiStatus.groupBy({
    by: ["code"],
    where: {
      roundCode,
      animal: { is: { usEvaluations: { some: { isPreferred: true, runKind: "official", approvalStatus: "approved" } } } },
    },
    _count: { _all: true },
  });
  const of = (code: string) => groups.find((g) => g.code === code)?._count._all ?? 0;
  const total = groups.reduce((s, g) => s + g._count._all, 0);
  if (total === 0) return null;
  return { roundCode, A: of("A"), G: of("G"), F: of("F"), total };
}

// --- presentation ------------------------------------------------------------

/** Human label for a YYMM round code, via the file-kind module so there is only
 *  one place in the app that turns 2604 into "April 2026". */
function roundLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return cdcbRoundLabel({
    family: "all_evaluated", kind: "official", breed: null,
    roundCode: code, periodKey: `R${code}`, date: code,
  }) ?? code;
}

interface TopRow {
  usEvaluationId: string;
  usAnimalId: string;
  evalBreed: string | null;
  naabCode: string | null;
  tpi: number | null;
  tpiFormulaVersion: string | null;
  nmDollar: number | null;
  ptat: number | null;
  // Identity comes off the AMERICAN roster: an American bull has no Canadian
  // Animal row unless he happens to be registered in Canada too.
  usAnimal: { name: string | null; id17: string };
}

/**
 * A leaderboard. Rump Angle is absent by construction — it has an intermediate
 * optimum, so it can appear on a bull's card but never in a ranked list.
 */
function TopTable({ rows, valueLabel }: { rows: TopRow[]; valueLabel: "GTPI" | "NM$" }) {
  return (
    <>
      <Table head={<>
        <th className="th w-8">#</th>
        <th className="th">Bull</th>
        <th className="th">Breed</th>
        <th className="th text-right">GTPI</th>
        <th className="th text-right">NM$</th>
        <th className="th text-right">PTAT</th>
      </>}>
        {rows.map((r, i) => (
          <tr key={r.usEvaluationId} className="hover:bg-slate-50">
            <td className="td text-slate-400">{i + 1}</td>
            <td className="td">
              <Link href={`/us/animals/${r.usAnimalId}`} className="link font-medium">{(r.usAnimal.name ?? r.usAnimal.id17)}</Link>
              {r.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {r.naabCode}</span>}
            </td>
            <td className="td text-xs text-slate-500">{r.evalBreed ?? "—"}</td>
            <td className={`td text-right tabular-nums ${valueLabel === "GTPI" ? "font-semibold text-brand-700" : "text-slate-600"}`}
                title={r.tpi != null && r.tpiFormulaVersion ? `Calculated using the ${r.tpiFormulaVersion} formula` : undefined}>
              {r.tpi ?? "—"}
            </td>
            <td className={`td text-right tabular-nums ${valueLabel === "NM$" ? "font-semibold text-brand-700" : "text-slate-600"}`}>
              {r.nmDollar == null ? "—" : `$${Math.round(r.nmDollar)}`}
            </td>
            <td className="td text-right tabular-nums text-slate-600">{r.ptat == null ? "—" : r.ptat.toFixed(2)}</td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 text-[11px] text-slate-500">
        Preferred official round only. All values are PTAs in <strong>pounds</strong>.
        {valueLabel === "GTPI" && " GTPI is calculated, not published — see the formula card below."}
      </p>
    </>
  );
}

function Bar({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-xs"><span>{label}</span><span className="text-slate-500">{fmtNum(value)} ({pct}%)</span></div>
      <div className="h-2 w-full rounded-full bg-slate-100"><div className={`h-2 rounded-full ${tone}`} style={{ width: `${pct}%` }} /></div>
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

function DifferencesCard() {
  return (
    <Card title="What is different on this side" className="mt-4">
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
        <li><strong>Values are PTAs in pounds</strong>, not EBVs in kilograms — roughly half a Canadian breeding value, so no number here is directly comparable to its Canadian counterpart.</li>
        <li><strong>One file per round.</strong> CDCB has no official/interim pair, so there is no interim report on this side.</li>
        <li><strong>No Rollback Resistance.</strong> That measures Canada&rsquo;s annual April re-basing; the US re-bases roughly every five years, so the metric has no US meaning.</li>
        <li><strong>Proven vs genomic</strong> comes from CDCB&rsquo;s per-trait evaluation flag, and <strong>active</strong> from the AI status file — not from carrying a NAAB code.</li>
        <li><strong>Rump Angle is never ranked</strong> anywhere in this system. It has an intermediate optimum, so a &ldquo;top rump angle&rdquo; list would be meaningless.</li>
      </ul>
    </Card>
  );
}

/** The US tables have not been created. Copied from /us/animals so every US page
 *  gives the same two commands in the same order. */
function SetupState() {
  return (
    <div>
      <PageHeader title="American genetics" subtitle="CDCB evaluations" />
      <Card title="The American tables have not been created yet">
        <p className="text-sm text-slate-600">
          The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
          CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
        <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
      </Card>
    </div>
  );
}

/**
 * The tables exist but hold no US evaluation.
 *
 * This is the page's original content and it is kept on purpose: it reports what
 * the engine is ready to do rather than rendering a lineup of zeroes, which would
 * read as an import that ran and failed rather than one that has not been run.
 */
function EngineReadyState() {
  const tpi = resolveTpiFormula(CURRENT_ROUND);
  const jpi = resolveJpiFormula(CURRENT_ROUND);

  return (
    <div>
      <PageHeader
        title="American genetics"
        subtitle={
          <span>
            CDCB evaluations — PTAs in pounds, published April / August / December.{" "}
            <Badge tone="blue">{roundLabel(CURRENT_ROUND)}</Badge>
          </span>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Evaluation round" value={roundLabel(CURRENT_ROUND)} hint={`round ${CURRENT_ROUND} · official`} />
        <StatCard label="Breeds published" value={CDCB_BREEDS.length} hint={CDCB_BREEDS.join(" · ")} tone="accent" />
        <StatCard label="Index formulas" value={INDEX_REGISTRY.tpi.length + JPI_REGISTRY.length} hint="versioned by round" />
        <StatCard label="Animals imported" value="—" hint="importer not yet run" />
      </div>

      <Card title="No CDCB round has been imported yet" className="mb-4">
        <p className="text-sm text-slate-600">
          The tables are in place and every part of the engine below is ready — there is simply nothing in
          them yet. Import a round and this page fills in with the lineup itself: counts by breed, by AI
          status and by proven-vs-genomic, the top bulls by GTPI and Net Merit, and what the importer wrote.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
      </Card>

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

      <DifferencesCard />
    </div>
  );
}
