import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { sameNaab } from "@/lib/us-cdcb/identity";
import { CDCB_ID_TYPE } from "@/lib/us-cdcb/persist";
import { cdcbRunKindLabel } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Data quality for the AMERICAN side.
//
// The Canadian page (src/app/(app)/admin/data-quality/page.tsx) cannot answer
// these questions, and one of its checks is actively wrong here: its "no genetic
// proof" count reads `evaluations: { none: {} }`, which is GeneticEvaluation only,
// so every bull this app holds solely on a CDCB round is reported there as having
// no proof at all. This page is the US-shaped counterpart.
//
// TWO THINGS IT REFUSES TO DO.
//
//   1. It does not call "an animal with no US evaluation" a defect on its own.
//      The Animal table is SHARED — the Canadian roster lives in it too, and most
//      of it will never appear in a CDCB file. The number worth flagging is the
//      narrower one: an animal already carrying a cdcb_id17 identifier (so a CDCB
//      import has touched it once) that now holds no US evaluation.
//   2. It does not flag unmatched AI-status rows as an error. About 5% of the
//      status file matches no animal we hold, and that is the file describing
//      CDCB's population rather than this stud's. It is reported as a rate with
//      that explanation attached.
//
// Reads UsEvaluation ONLY — never GeneticEvaluation.
// ---------------------------------------------------------------------------

/** Bounds the row-level scan behind the NAAB and breed checks. */
const MAX_SCAN = 20000;
/** Samples shown per finding. The counts above them are the full figures. */
const SAMPLE = 12;
/** Unmatched AI-status entries below this share of the file are normal. */
const AI_ORPHAN_EXPECTED = 0.08;

export default async function UsDataQualityPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/us/dashboard");

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

  if (missingTables || !data) {
    return (
      <div>
        <PageHeader title="Data Quality · American" subtitle="CDCB evaluations" />
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

  const {
    lineup, rosterTotal, rosterWithUs, taggedNoEval, taggedNoEvalS,
    evalsNoId17, evalsNoId17S, pending, rejected,
    periods, officialRounds, naabConflicts, breedMismatch, crossbredMismatch,
    ai, scanned, scanCapped,
  } = data;

  if (lineup === 0) {
    return (
      <div>
        <PageHeader title="Data Quality · American" subtitle="CDCB evaluations" />
        <EmptyState message="No CDCB round has been imported yet, so there is nothing to check. Import a round and every indicator on this page computes itself." />
      </div>
    );
  }

  const orphanRate = ai.total ? ai.orphans / ai.total : 0;
  const orphanExpected = orphanRate <= AI_ORPHAN_EXPECTED;

  return (
    <div>
      <PageHeader
        title="Data Quality · American"
        subtitle="Indicators over the CDCB side only. Nothing here is deleted or changed automatically."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MiniStat label="Tagged, no US evaluation" value={taggedNoEval} />
        <MiniStat label="Evaluations with no CDCB id" value={evalsNoId17} />
        <MiniStat label="NAAB disagreements" value={naabConflicts.length} />
        <MiniStat label="Breed disagreements" value={breedMismatch.length} />
        <MiniStat label="Awaiting approval" value={pending} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Animals and US evaluations">
          <Finding
            title="Carries a CDCB id but holds no US evaluation"
            count={taggedNoEval}
            animals={taggedNoEvalS}
            why="A cdcb_id17 identifier is only ever written by the CDCB importer, so one of these animals was linked on a previous run and now has no evaluation attached — either the round was removed or the link moved to a different animal."
          />
          <Finding
            title="US evaluation whose animal carries no CDCB id"
            count={evalsNoId17}
            animals={evalsNoId17S}
            why="The importer writes the id17 as an identifier so the next round resolves in one indexed query. A row without it will re-resolve the slow way, and may create a duplicate animal instead of linking."
          />
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <strong>{fmtNum(rosterTotal - rosterWithUs)}</strong> of the {fmtNum(rosterTotal)} animals in the roster
            have no US evaluation. <strong>That is expected, not a fault.</strong> The animal table is shared with
            the Canadian side and most of it — every female, and every Canadian-only bull — will never appear in a
            CDCB file. Only the two counts above describe something that needs looking at.
          </div>
        </Card>

        <Card title="Rounds on file">
          <Table head={<>
            <th className="th">Period</th>
            <th className="th">Kind</th>
            <th className="th text-right">Rows</th>
            <th className="th text-right">Evaluated</th>
          </>}>
            {periods.map((p) => (
              <tr key={`${p.periodKey}|${p.runKind}`}>
                <td className="td font-mono text-xs">{p.periodKey}</td>
                <td className="td">
                  <Badge tone={p.runKind === "official" ? "green" : p.runKind === "provisional" ? "amber" : "slate"}>
                    {cdcbRunKindLabel(p.runKind as "official" | "provisional" | "unofficial")}
                  </Badge>
                </td>
                <td className="td text-right tabular-nums">{fmtNum(p.rows)}</td>
                <td className="td text-right text-xs text-slate-500">{p.at ? p.at.toISOString().slice(0, 10) : "—"}</td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-[11px] text-slate-500">
            The period key is prefixed on purpose: <code>R2604</code> is the April official round,
            <code> M2604</code> a monthly add published the same month, <code>W20260802</code> a weekly one.
            Without the prefix a provisional add could displace the official round for an animal.
            <strong> {fmtNum(officialRounds)} official round{officialRounds === 1 ? "" : "s"}</strong> — only these are
            authoritative, and only these are ranked or reported on.
          </p>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Conflicts flagged at import">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Badge tone={pending ? "amber" : "slate"}>{fmtNum(pending)} pending approval</Badge>
            <Badge tone={rejected ? "red" : "slate"}>{fmtNum(rejected)} rejected</Badge>
            <Badge tone={naabConflicts.length ? "red" : "slate"}>{fmtNum(naabConflicts.length)} NAAB disagreements</Badge>
          </div>

          {naabConflicts.length === 0 ? (
            <div className="text-xs text-emerald-700">✓ no NAAB disagreement between a US evaluation and the animal it is attached to</div>
          ) : (
            <Table head={<>
              <th className="th">Bull</th>
              <th className="th">Held here</th>
              <th className="th">CDCB says</th>
            </>}>
              {naabConflicts.slice(0, SAMPLE).map((c) => (
                <tr key={c.usAnimalId + c.id17}>
                  <td className="td">
                    <Link href={`/us/animals/${c.usAnimalId}`} className="link font-medium">{c.name}</Link>
                    <span className="mt-0.5 block font-mono text-[10px] text-slate-400">{c.id17}</span>
                  </td>
                  <td className="td font-mono text-xs text-slate-600">{c.stored.join(" · ")}</td>
                  <td className="td font-mono text-xs text-red-600">{c.cdcb}</td>
                </tr>
              ))}
            </Table>
          )}
          {naabConflicts.length > SAMPLE && (
            <div className="mt-2 text-xs text-slate-400">+{fmtNum(naabConflicts.length - SAMPLE)} more</div>
          )}

          <p className="mt-3 text-[11px] text-slate-500">
            A NAAB disagreement is the conflict class that survives the import. <code>assessLink()</code> blocks a
            link outright when the codes disagree — NAAB codes are reused between bulls, so importing through one
            would graft a new bull&rsquo;s proof onto the last holder — and the refusal is reported by the importer
            but is <strong>not stored anywhere</strong>: the CLI prints a conflict count and discards it. So the
            rows above are the disagreements detectable after the fact, on animals where a link was made and a
            stored NAAB later diverged. Until the CDCB importer writes its refusals to the review queue, the
            &ldquo;pending&rdquo; count is the gate that would hold them, and it will read zero.
          </p>
        </Card>

        <Card title="Breed disagreements">
          <div className="mb-2 text-xs text-slate-500">
            CDCB&rsquo;s EVAL_BREED against the breed stored on the animal, over the {fmtNum(scanned)} bulls on
            their preferred official round.
          </div>
          {breedMismatch.length === 0 ? (
            <div className="text-xs text-emerald-700">✓ every straightbred evaluation agrees with the animal&rsquo;s stored breed</div>
          ) : (
            <Table head={<>
              <th className="th">Bull</th>
              <th className="th">Stored</th>
              <th className="th">Evaluated as</th>
            </>}>
              {breedMismatch.slice(0, SAMPLE).map((m) => (
                <tr key={m.usAnimalId + m.id17}>
                  <td className="td"><Link href={`/us/animals/${m.usAnimalId}`} className="link font-medium">{m.name}</Link></td>
                  <td className="td text-xs text-slate-600">{m.stored}</td>
                  <td className="td text-xs font-medium text-amber-700">{m.evaluated}</td>
                </tr>
              ))}
            </Table>
          )}
          {breedMismatch.length > SAMPLE && (
            <div className="mt-2 text-xs text-slate-400">+{fmtNum(breedMismatch.length - SAMPLE)} more</div>
          )}

          <p className="mt-3 text-[11px] text-slate-500">
            EVAL_BREED is the breed the animal was <em>evaluated</em> in, which is not always its registry breed —
            549 animals in the Holstein file carry a non-HO id prefix. A disagreement is worth a look, not an
            automatic correction. <strong>{fmtNum(crossbredMismatch)}</strong> further disagreement
            {crossbredMismatch === 1 ? " is" : "s are"} on animals CDCB marks crossbred (BLEND_CODE M) and
            {crossbredMismatch === 1 ? " is" : " are"} excluded above — for a crossbred the two answers are
            <em> supposed</em> to differ.
          </p>
        </Card>
      </div>

      <Card title="AI-status file coverage" className="mt-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MiniStat label="Status rows on file" value={ai.total} neutral />
          <MiniStat label="Matched to an animal" value={ai.total - ai.orphans} neutral />
          <MiniStat label="Matching no animal" value={ai.orphans} neutral={orphanExpected} />
          <MiniStat label="Unmatched rate" value={`${Math.round(orphanRate * 100)}%`} neutral={orphanExpected} />
        </div>
        <p className="mt-3 text-sm text-slate-600">
          {orphanExpected ? (
            <>
              <strong className="text-emerald-700">This is normal.</strong> CDCB&rsquo;s AI-status file describes
              its own population, not this stud&rsquo;s — around 5% of its entries have always matched no animal we
              hold. The rows are kept rather than discarded so the figure stays visible and so a bull that arrives
              later picks up his status without a re-import.
            </>
          ) : (
            <>
              <strong className="text-amber-700">Higher than expected.</strong> Around 5% unmatched is normal and
              needs no action; {Math.round(orphanRate * 100)}% suggests the status file and the evaluation files are
              for different rounds, or that a breed&rsquo;s evaluation file was not imported alongside it.
            </>
          )}
        </p>
        {ai.byRound.length > 0 && (
          <Table head={<>
            <th className="th">Round</th>
            <th className="th text-right">Rows</th>
            <th className="th text-right">Unmatched</th>
          </>}>
            {ai.byRound.map((r) => (
              <tr key={r.roundCode}>
                <td className="td font-mono text-xs">{r.roundCode}</td>
                <td className="td text-right tabular-nums">{fmtNum(r.rows)}</td>
                <td className="td text-right tabular-nums text-slate-500">{fmtNum(r.orphans)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {scanCapped && (
        <p className="mt-3 text-[11px] text-amber-600">
          The NAAB and breed checks scanned the first {fmtNum(MAX_SCAN)} bulls of the lineup — it is larger than
          this page reads in one request, so those two counts are a floor rather than a total.
        </p>
      )}
    </div>
  );
}

// --- data --------------------------------------------------------------------

async function load() {
  // Only official rows are authoritative, and isPreferred already only ever lands
  // on one — the runKind filter is stated anyway so a change to the preferred
  // recompute cannot quietly admit a provisional monthly into these checks.
  const officialPreferred: Prisma.UsEvaluationWhereInput = {
    isPreferred: true, runKind: "official", approvalStatus: "approved",
  };
  /** An animal the CDCB importer has linked at least once. */
  const cdcbTagged: Prisma.AnimalWhereInput = {
    archived: false, identifiers: { some: { idType: CDCB_ID_TYPE } },
  };
  const evalNoId17: Prisma.UsEvaluationWhereInput = {
    animal: { identifiers: { none: { idType: CDCB_ID_TYPE } } },
  };

  const [
    lineup, rosterTotal, rosterWithUs, taggedNoEval, taggedNoEvalS,
    evalsNoId17, evalsNoId17Rows, pending, rejected, periodGroups,
    aiTotal, aiOrphans, aiRoundGroups, aiOrphanGroups, scanRows,
  ] = await Promise.all([
    prisma.usEvaluation.count({ where: officialPreferred }),
    prisma.animal.count({ where: { archived: false } }),
    prisma.animal.count({ where: { archived: false, usEvaluations: { some: {} } } }),
    prisma.animal.count({ where: { ...cdcbTagged, usEvaluations: { none: {} } } }),
    prisma.animal.findMany({ where: { ...cdcbTagged, usEvaluations: { none: {} } }, select: { id: true, primaryName: true }, take: SAMPLE }),
    prisma.usEvaluation.count({ where: evalNoId17 }),
    prisma.usEvaluation.findMany({ where: evalNoId17, select: { usAnimalId: true, id17: true, usAnimal: { select: { name: true, id17: true } } }, take: SAMPLE }),
    prisma.usEvaluation.count({ where: { approvalStatus: "pending" } }),
    prisma.usEvaluation.count({ where: { approvalStatus: "rejected" } }),
    prisma.usEvaluation.groupBy({ by: ["periodKey", "runKind"], _count: { _all: true }, _max: { evaluationDate: true } }),
    prisma.usAiStatus.count(),
    prisma.usAiStatus.count({ where: { animalId: null } }),
    prisma.usAiStatus.groupBy({ by: ["roundCode"], _count: { _all: true } }),
    prisma.usAiStatus.groupBy({ by: ["roundCode"], where: { animalId: null }, _count: { _all: true } }),
    // One scan answers both row-level checks. Doing it twice would double the cost
    // of the most expensive query on the page for no extra information.
    prisma.usEvaluation.findMany({
      where: officialPreferred,
      take: MAX_SCAN,
      select: {
        usAnimalId: true, id17: true, naabCode: true, evalBreed: true, blendCode: true,
        usAnimal: { select: { name: true, id17: true } },
        animal: {
          select: {
            primaryName: true,
            breed: { select: { breedCode: true } },
            identifiers: { where: { idType: "naab", active: true }, select: { idValue: true } },
          },
        },
      },
    }),
  ]);

  const periods = periodGroups
    .map((g) => ({ periodKey: g.periodKey, runKind: g.runKind, rows: g._count._all, at: g._max.evaluationDate }))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const officialRounds = periods.filter((p) => p.runKind === "official").length;

  // NAAB: only a row where the app holds a code AND CDCB reports one can disagree.
  // A missing code on either side is silence, not a contradiction.
  const naabConflicts: { usAnimalId: string; id17: string; name: string; stored: string[]; cdcb: string }[] = [];
  const breedMismatch: { usAnimalId: string; id17: string; name: string; stored: string; evaluated: string }[] = [];
  let crossbredMismatch = 0;

  for (const r of scanRows) {
    if (!r.animal) continue; // not dual-registered: nothing here to disagree with
    const stored = r.animal.identifiers.map((i) => i.idValue);
    if (r.naabCode && stored.length > 0 && !stored.some((v) => sameNaab(v, r.naabCode))) {
      naabConflicts.push({ usAnimalId: r.usAnimalId, id17: r.id17, name: (r.usAnimal.name ?? r.usAnimal.id17), stored, cdcb: r.naabCode });
    }
    const storedBreed = r.animal.breed?.breedCode ?? null;
    if (storedBreed && r.evalBreed && storedBreed !== r.evalBreed) {
      // BLEND_CODE M is CDCB's crossbred flag. A crossbred is EXPECTED to be
      // evaluated in a breed other than the one it is registered in, so counting
      // those alongside genuine disagreements would bury the ones that matter.
      if (r.blendCode === "M") crossbredMismatch++;
      else breedMismatch.push({ usAnimalId: r.usAnimalId, id17: r.id17, name: (r.usAnimal.name ?? r.usAnimal.id17), stored: storedBreed, evaluated: r.evalBreed });
    }
  }

  const orphanByRound = new Map(aiOrphanGroups.map((g) => [g.roundCode, g._count._all]));
  const byRound = aiRoundGroups
    .map((g) => ({ roundCode: g.roundCode, rows: g._count._all, orphans: orphanByRound.get(g.roundCode) ?? 0 }))
    .sort((a, b) => b.roundCode.localeCompare(a.roundCode));

  return {
    lineup, rosterTotal, rosterWithUs, taggedNoEval, taggedNoEvalS,
    evalsNoId17,
    // One animal can hold several rounds, so the sample is per ANIMAL — otherwise
    // the same bull would be listed once per evaluation he carries.
    evalsNoId17S: [...new Map(evalsNoId17Rows.map((r) => [r.usAnimalId, { id: r.usAnimalId, primaryName: (r.usAnimal.name ?? r.usAnimal.id17) }])).values()],
    pending, rejected, periods, officialRounds,
    naabConflicts, breedMismatch, crossbredMismatch,
    ai: { total: aiTotal, orphans: aiOrphans, byRound },
    scanned: scanRows.length,
    scanCapped: scanRows.length >= MAX_SCAN,
  };
}

// --- presentation ------------------------------------------------------------

function MiniStat({ label, value, neutral = false }: { label: string; value: number | string; neutral?: boolean }) {
  const flagged = !neutral && typeof value === "number" && value > 0;
  return (
    <div className="card card-pad">
      <div className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-slate-500 break-words">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${flagged ? "text-amber-600" : "text-slate-800"}`}>
        {typeof value === "number" ? fmtNum(value) : value}
      </div>
    </div>
  );
}

/** One finding: the count, a sample that links into the US card (never the
 *  Canadian one — the units differ), and why it is worth reading. */
function Finding({
  title, count, animals, why,
}: {
  title: string; count: number; animals: { id: string; primaryName: string }[]; why: string;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title} ({fmtNum(count)})</div>
      {count === 0 ? (
        <div className="text-xs text-emerald-700">✓ none</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {animals.map((a) => <Link key={a.id} href={`/us/animals/${a.id}`} className="link text-sm">{a.primaryName}</Link>)}
            {count > animals.length && <span className="text-xs text-slate-400">+{fmtNum(count - animals.length)} more</span>}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">{why}</p>
        </>
      )}
    </div>
  );
}
