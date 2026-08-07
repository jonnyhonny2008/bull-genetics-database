import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, Badge, EmptyState, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { US_KEY_TRAITS, US_SORTABLE_KEY_TRAITS, formatUsTrait } from "@/lib/us-cdcb/key-traits";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// The American lineup. Reads UsEvaluation — never GeneticEvaluation — so a
// Canadian number can never leak into this table, which would be the worst
// possible bug here (PTAs in pounds sitting in a column labelled like an EBV in kg).

export default async function UsAnimalsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  const page = Math.max(1, parseInt(searchParams.page ?? "1") || 1);
  const dir: "asc" | "desc" = searchParams.dir === "asc" ? "asc" : "desc";
  const breed = (searchParams.breed ?? "").toUpperCase();
  const q = (searchParams.q ?? "").trim();

  // Only rankable traits may be sorted on — rump angle has an intermediate
  // optimum, so "highest first" would be a meaningless ordering.
  const sortTrait = US_SORTABLE_KEY_TRAITS.find((t) => t.code === (searchParams.sort ?? "GTPI").toUpperCase())
    ?? US_SORTABLE_KEY_TRAITS[0];

  let rows: Awaited<ReturnType<typeof loadRows>> = { list: [], total: 0, missingTables: false };
  try {
    rows = await loadRows({ page, dir, breed, q, sortColumn: sortTrait.column });
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, say so
    // plainly rather than rendering a 500 — this is a setup state, not a fault.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) {
      rows.missingTables = true;
    } else throw e;
  }

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...searchParams, ...over })) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/us/animals?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="American lineup"
        subtitle={
          rows.missingTables
            ? "CDCB evaluations"
            : `${fmtNum(rows.total)} bull${rows.total === 1 ? "" : "s"} with a US evaluation · sorted by ${sortTrait.label}`
        }
      />

      {rows.missingTables ? (
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run db:push:prod</pre>
          <p className="mt-3 text-sm text-slate-600">Then import a CDCB round:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">
            Both are additive — no existing Canadian table is touched.
          </p>
        </Card>
      ) : rows.list.length === 0 ? (
        <EmptyState message="No US evaluations imported yet. Run a CDCB round through the importer to populate this list." />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Link href={qs({ breed: undefined, page: undefined })} className={`rounded-full border px-3 py-1 text-xs font-medium ${!breed ? "border-brand-400 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-600 hover:border-brand-300"}`}>All breeds</Link>
            {CDCB_BREEDS.map((b) => (
              <Link key={b} href={qs({ breed: b, page: undefined })} className={`rounded-full border px-3 py-1 text-xs font-medium ${breed === b ? "border-brand-400 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-600 hover:border-brand-300"}`}>{b}</Link>
            ))}
          </div>

          <div className="card">
            <Table head={<>
              <th className="th">Bull</th>
              <th className="th">Breed</th>
              {US_KEY_TRAITS.map((t) => (
                <th key={t.code} className="th text-right" title={t.direction === "intermediate" ? `${t.label} — intermediate optimum, so it is not ranked` : t.label}>
                  {US_SORTABLE_KEY_TRAITS.includes(t) ? (
                    <Link href={qs({ sort: t.code, dir: sortTrait.code === t.code && dir === "desc" ? "asc" : "desc", page: undefined })} className="hover:underline">
                      {t.short}{sortTrait.code === t.code ? (dir === "desc" ? " ↓" : " ↑") : ""}
                    </Link>
                  ) : (
                    <span title="Intermediate optimum — not ranked">{t.short}</span>
                  )}
                </th>
              ))}
              <th className="th">Round</th>
            </>}>
              {rows.list.map((r) => (
                <tr key={r.usEvaluationId} className="hover:bg-slate-50">
                  <td className="td">
                    <Link href={`/animals/${r.animalId}`} className="link font-medium">{r.animal.primaryName}</Link>
                    {r.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {r.naabCode}</span>}
                  </td>
                  <td className="td text-xs text-slate-500">{r.evalBreed ?? "—"}</td>
                  {US_KEY_TRAITS.map((t) => (
                    <td key={t.code} className="td text-right tabular-nums">
                      {t.code === "GTPI" && r.tpi != null ? (
                        <span title={`Calculated using the ${r.tpiFormulaVersion} formula`} className="font-semibold">{r.tpi}</span>
                      ) : (
                        formatUsTrait(t, r[t.column] as number | null)
                      )}
                    </td>
                  ))}
                  <td className="td text-xs text-slate-500">
                    {r.roundCode ? <Badge tone="blue">{r.roundCode}</Badge> : <Badge>{r.runKind}</Badge>}
                  </td>
                </tr>
              ))}
            </Table>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
            Association USA formula in force for each round. It is not an official Holstein Association USA
            publication and is typically within ±3 points of the published figure. TPI is a registered
            trademark of Holstein Association USA. Rump Angle has an intermediate optimum and is shown but
            not ranked. All yield values are PTAs in pounds.
          </p>

          {rows.total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-slate-500">Page {page} of {Math.ceil(rows.total / PAGE_SIZE)}</span>
              <div className="flex gap-2">
                {page > 1 && <Link href={qs({ page: page - 1 })} className="btn-secondary btn-sm">‹ Prev</Link>}
                {page * PAGE_SIZE < rows.total && <Link href={qs({ page: page + 1 })} className="btn-secondary btn-sm">Next ›</Link>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

async function loadRows(opts: { page: number; dir: "asc" | "desc"; breed: string; q: string; sortColumn: string }) {
  const where = {
    isPreferred: true,
    approvalStatus: "approved",
    ...(opts.breed ? { evalBreed: opts.breed } : {}),
    ...(opts.q
      ? { animal: { primaryName: { contains: opts.q, mode: "insensitive" as const } } }
      : {}),
  };
  const [total, list] = await Promise.all([
    prisma.usEvaluation.count({ where }),
    prisma.usEvaluation.findMany({
      where,
      orderBy: { [opts.sortColumn]: { sort: opts.dir, nulls: "last" } },
      skip: (opts.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        usEvaluationId: true, animalId: true, evalBreed: true, naabCode: true,
        roundCode: true, runKind: true, tpi: true, tpiFormulaVersion: true,
        nmDollar: true, ptat: true, milk: true, rpa: true, dpr: true, ccr: true,
        animal: { select: { primaryName: true } },
      },
    }),
  ]);
  return { list, total, missingTables: false };
}
