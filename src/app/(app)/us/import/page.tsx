import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, EmptyState, Table, Badge, StatCard } from "@/components/ui";
import { fmtNum, fmtDate } from "@/lib/format";
import { usRoundLabel } from "@/lib/us-cdcb/proof-change";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// WHAT IS LOADED ON THE AMERICAN SIDE — the audit screen for the CDCB importer.
//
// This is READ-ONLY, and that is a decision rather than an omission. The Canadian
// Uploads page accepts a file because Lactanet reports arrive one at a time and
// small. A CDCB round is twelve files and ~260 MB, and Vercel's filesystem is
// read-only, so a browser upload could not be written anywhere to be parsed. The
// honest shape is: run the import where the files are, and use this page to see
// exactly what landed and to catch what did not.
// ---------------------------------------------------------------------------

interface PeriodRow {
  periodKey: string;
  roundCode: string | null;
  runKind: string;
  evaluationDate: Date;
  animals: number;
  breeds: string[];
  files: string[];
  withTpi: number;
  withJpi: number;
  preferred: number;
}

async function load() {
  const groups = await prisma.usEvaluation.groupBy({
    by: ["periodKey", "roundCode", "runKind", "evaluationDate"],
    _count: { _all: true },
    orderBy: { evaluationDate: "desc" },
  });

  const periods: PeriodRow[] = [];
  for (const g of groups) {
    const where = { periodKey: g.periodKey };
    const [byBreed, byFile, withTpi, withJpi, preferred] = await Promise.all([
      prisma.usEvaluation.groupBy({ by: ["evalBreed"], where, _count: { _all: true } }),
      prisma.usEvaluation.groupBy({ by: ["sourceFile"], where, _count: { _all: true } }),
      prisma.usEvaluation.count({ where: { ...where, tpi: { not: null } } }),
      prisma.usEvaluation.count({ where: { ...where, jpi: { not: null } } }),
      prisma.usEvaluation.count({ where: { ...where, isPreferred: true } }),
    ]);
    periods.push({
      periodKey: g.periodKey,
      roundCode: g.roundCode,
      runKind: g.runKind,
      evaluationDate: g.evaluationDate,
      animals: g._count._all,
      breeds: byBreed.map((b) => `${b.evalBreed ?? "—"} ${fmtNum(b._count._all)}`),
      files: byFile.map((f) => f.sourceFile).filter((f): f is string => !!f).sort(),
      withTpi, withJpi, preferred,
    });
  }
  const [roster, bridged, aiRows, aiRounds] = await Promise.all([
    prisma.usAnimal.count(),
    prisma.usAnimal.count({ where: { animalId: { not: null } } }),
    prisma.usAiStatus.count(),
    prisma.usAiStatus.groupBy({ by: ["roundCode"], _count: { _all: true } }),
  ]);
  return { periods, roster, bridged, aiRows, aiRounds };
}

export default async function UsImportPage() {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  let data: Awaited<ReturnType<typeof load>> | null = null;
  let missingTables = false;
  try {
    data = await load();
  } catch (e) {
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) missingTables = true;
    else throw e;
  }

  const officials = data?.periods.filter((p) => p.runKind === "official") ?? [];
  const notPreferred = data?.periods.reduce((a, p) => a + (p.runKind === "official" ? p.animals - p.preferred : 0), 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="CDCB rounds on file"
        subtitle="What the American importer has loaded, which files each round came from, and what it refused to link."
      />

      {missingTables || !data ? (
        <Card title="The American tables have not been created yet">
          <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
        </Card>
      ) : data.periods.length === 0 ? (
        <Card title="Nothing imported yet">
          <p className="text-sm text-slate-600">Point the importer at a folder of extracted CDCB member files:</p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;.\imports\cdcb&quot;</pre>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <StatCard label="Bulls on the American roster" value={fmtNum(data.roster)} hint="UsAnimal rows" />
            <StatCard label="Also registered in Canada" value={fmtNum(data.bridged)} hint="double cards" />
            <StatCard label="Periods on file" value={String(data.periods.length)} hint={`${officials.length} official`} />
            <StatCard label="AI-status rows" value={fmtNum(data.aiRows)} hint={data.aiRows ? `${data.aiRounds.length} round(s)` : "no status file loaded"} />
          </div>

          {data.aiRows === 0 && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <strong>No AI-status file has been loaded.</strong> CDCB publishes marketing status separately, and it is
              what decides whether a bull is actually being sold — carrying a NAAB code is not that answer. Until an
              <span className="font-mono"> aistatus.</span> file sits alongside the round files, the Active-AI role
              filter has nothing to filter on.
            </div>
          )}

          {notPreferred > 0 && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <strong>{fmtNum(notPreferred)} official rows are not marked preferred.</strong> The lineup reads the
              preferred row, so those bulls will not appear in it. Re-run the importer to recompute.
            </div>
          )}

          <div className="mt-4 space-y-4">
            {data.periods.map((p) => (
              <Card
                key={p.periodKey}
                title={`${p.roundCode ? usRoundLabel(p.roundCode) : p.periodKey} — ${fmtNum(p.animals)} evaluations`}
                actions={
                  <Badge tone={p.runKind === "official" ? "brand" : "slate"}>
                    {p.runKind}
                  </Badge>
                }
              >
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                  <Row k="Period key" v={<span className="font-mono text-xs">{p.periodKey}</span>} />
                  <Row k="Evaluation date" v={fmtDate(p.evaluationDate)} />
                  <Row k="Marked preferred" v={fmtNum(p.preferred)} />
                  <Row k="Index computed" v={`${fmtNum(p.withTpi)} GTPI · ${fmtNum(p.withJpi)} JPI`} />
                </dl>

                <p className="mt-3 text-xs text-slate-500"><strong>Breeds:</strong> {p.breeds.join(" · ")}</p>

                {p.runKind !== "official" && (
                  <p className="mt-2 text-xs text-amber-700">
                    A {p.runKind} run. These rows are never ranked alongside an official round and never become a
                    bull&rsquo;s preferred evaluation — they are carried so a between-round change is visible, not so it
                    can be sold on.
                  </p>
                )}

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-slate-600">
                    {p.files.length} source file{p.files.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-slate-500">
                    {p.files.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                </details>
              </Card>
            ))}
          </div>

          <Card title="Loading another round" className="mt-4">
            <p className="text-sm text-slate-600">
              Extract the CDCB member files into a folder — each round is an <span className="font-mono">infoANIM</span>{" "}
              and <span className="font-mono">infoEVAL</span> pair per breed — then:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:dry -- &quot;.\imports\cdcb&quot;</pre>
            <p className="mt-2 text-xs text-slate-500">
              The dry run parses every file and computes every index without writing anything, so a bad round is caught
              before it reaches the database. When it reads clean, drop <span className="font-mono">:dry</span> for{" "}
              <span className="font-mono">:prod</span>.
            </p>
            <p className="mt-3 text-xs text-slate-500">
              Uploading through the browser is deliberately not offered here: a round is twelve files and roughly 260 MB,
              and the server filesystem is read-only in the cloud, so there would be nowhere to put them.
            </p>
          </Card>
        </>
      )}

      <p className="mt-4 text-xs text-slate-400">
        <Link href="/us/admin/data-quality" className="link">Data quality checks →</Link>
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{k}</dt>
      <dd className="text-slate-700">{v}</dd>
    </div>
  );
}
