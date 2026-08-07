import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, EmptyState, Table, StatCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getUsParentAverage, type PaTrait } from "@/lib/us-cdcb/parent-average";
import { US_GTPI_NOTE, US_TPI_TRADEMARK, US_POUNDS_NOTE } from "@/lib/us-cdcb/report-notes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const dp = (code: string) => (["MILK", "FAT", "PRO", "NM", "CM", "FM", "GM", "FS"].includes(code) ? 0 : 2);
const sign = (v: number, d: number) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

export default async function UsParentAveragePage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  const q = (searchParams.q ?? "").trim();
  const id = searchParams.id ?? "";

  let missingTables = false;
  let matches: { usAnimalId: string; id17: string; name: string | null; naabCode: string | null; breedCode: string | null }[] = [];
  let report: Awaited<ReturnType<typeof getUsParentAverage>> = null;

  try {
    if (id) {
      report = await getUsParentAverage(id);
    } else if (q) {
      matches = await prisma.usAnimal.findMany({
        where: {
          archived: false,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { naabCode: { contains: q.toUpperCase() } },
            { id17: { contains: q.toUpperCase() } },
          ],
        },
        take: 25,
        orderBy: { name: "asc" },
        select: { usAnimalId: true, id17: true, name: true, naabCode: true, breedCode: true },
      });
      if (matches.length === 1) report = await getUsParentAverage(matches[0].usAnimalId);
    }
  } catch (e) {
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) missingTables = true;
    else throw e;
  }

  const byGroup = new Map<string, PaTrait[]>();
  for (const t of report?.traits ?? []) {
    const a = byGroup.get(t.group) ?? [];
    a.push(t);
    byGroup.set(t.group, a);
  }

  return (
    <div>
      <PageHeader
        title="Parent Average vs Genomic — CDCB"
        subtitle="How far the genomic test moved a bull off his pedigree expectation, trait by trait."
      />

      {missingTables ? (
        <Card title="The American tables have not been created yet">
          <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
        </Card>
      ) : (
        <>
          <form method="get" className="card card-pad flex flex-wrap items-end gap-3">
            <div className="grow">
              <label className="label" htmlFor="q">Bull</label>
              <input id="q" name="q" defaultValue={q} placeholder="Name, NAAB code or CDCB id" className="input w-full" />
            </div>
            <button type="submit" className="btn-primary">Find</button>
          </form>

          {!report && matches.length > 1 && (
            <Card title={`${matches.length} matches`} className="mt-4">
              <Table head={<><th className="th">Bull</th><th className="th">Breed</th><th className="th">NAAB</th><th className="th">CDCB id</th></>}>
                {matches.map((m) => (
                  <tr key={m.usAnimalId} className="hover:bg-slate-50">
                    <td className="td"><Link href={`/us/parent-average?id=${m.usAnimalId}`} className="link font-medium">{m.name ?? m.id17}</Link></td>
                    <td className="td text-xs text-slate-500">{m.breedCode ?? "—"}</td>
                    <td className="td font-mono text-xs text-slate-500">{m.naabCode ?? "—"}</td>
                    <td className="td font-mono text-[10px] text-slate-400">{m.id17}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          {!report && (q || id) && matches.length === 0 && (
            <div className="mt-4"><EmptyState message="No American bull matches that. Try a NAAB code or the 17-character CDCB id." /></div>
          )}

          {!report && !q && !id && (
            <Card title="What this report answers" className="mt-4">
              <p className="text-sm text-slate-600">
                CDCB publishes each bull&rsquo;s <strong>parent average</strong> — what his pedigree predicted — next to
                his <strong>genomic evaluation</strong>. The difference is what the DNA test actually told you that the
                pedigree did not. Search for a bull above.
              </p>
              <p className="mt-3 text-xs text-slate-500">
                This is deliberately not the same page as the Canadian Parent Average, which pairs a sire with a dam to
                predict a mating. That needs cow evaluations, and the CDCB bull files contain no cows — so rather than a
                page that could never return an answer, the American side answers the question its data supports.
              </p>
            </Card>
          )}

          {report && (
            <div className="mt-4 space-y-4">
              <Card
                title={report.name}
                actions={<Link href={`/us/animals/${report.usAnimalId}`} className="btn-secondary btn-sm">Full card →</Link>}
              >
                <p className="mb-3 text-xs text-slate-500">
                  {report.breed ?? "—"} · {report.roundLabel}
                  {report.naabCode && <> · NAAB <span className="font-mono">{report.naabCode}</span></>}
                  {" · "}<span className="font-mono">{report.id17}</span>
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatCard label="GTPI from pedigree" value={report.paTpi ?? "—"} hint="parent average through the round's own formula" />
                  <StatCard label="GTPI from genomics" value={report.gptaTpi ?? "—"} hint="the published evaluation" />
                  <StatCard
                    label="What the test added"
                    value={report.tpiDelta == null ? "—" : `${report.tpiDelta > 0 ? "+" : ""}${report.tpiDelta}`}
                    hint={report.tpiDelta == null ? "not computable" : report.tpiDelta > 0 ? "genomics above pedigree" : "genomics below pedigree"}
                  />
                </div>
                {report.tpiNote && <p className="mt-3 text-xs text-amber-700">{report.tpiNote}</p>}
              </Card>

              {[...byGroup.entries()].map(([group, traits]) => (
                <Card key={group} title={group}>
                  <Table head={<>
                    <th className="th">Trait</th>
                    <th className="th text-right">Pedigree (PA)</th>
                    <th className="th text-right">Genomic</th>
                    <th className="th text-right">Difference</th>
                    <th className="th text-right" title="How many breed standard deviations that difference is — the honest measure of whether it is unusual">vs breed</th>
                  </>}>
                    {traits.map((t) => {
                      const d = dp(t.code);
                      const notable = t.z != null && Math.abs(t.z) >= 1.5;
                      return (
                        <tr key={t.code} className="hover:bg-slate-50">
                          <td className="td">
                            {t.name}
                            {t.unit && <span className="ml-1 text-xs text-slate-400">{t.unit}</span>}
                            {t.intermediate && (
                              <span className="ml-2 rounded bg-slate-200 px-1 text-[9px] font-bold uppercase tracking-wide text-slate-600"
                                    title="Intermediate optimum — a move in either direction is not automatically good or bad news">opt</span>
                            )}
                          </td>
                          <td className="td text-right tabular-nums text-slate-500">{t.pa.toFixed(d)}</td>
                          <td className="td text-right tabular-nums text-slate-700">{t.gpta.toFixed(d)}</td>
                          <td className={`td text-right font-semibold tabular-nums ${t.intermediate ? "text-slate-600" : t.delta > 0 ? "text-brand-700" : t.delta < 0 ? "text-red-600" : "text-slate-500"}`}>
                            {sign(t.delta, d)}
                          </td>
                          <td className={`td text-right tabular-nums ${notable ? "font-semibold text-slate-800" : "text-slate-400"}`}>
                            {t.z == null ? "—" : `${t.z > 0 ? "+" : ""}${t.z.toFixed(1)} SD`}
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                </Card>
              ))}

              <Card title="How to read this">
                <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
                  <li>
                    <strong>A raw difference means little on its own.</strong> The last column is the one to read: it says
                    how far this bull&rsquo;s move is in {report.breed ?? "his breed"} standard deviations, measured over{" "}
                    {fmtNum(report.cohortN)} bulls of the same breed and round. Anything past ±1.5 SD is genuinely unusual.
                  </li>
                  <li>Traits are ordered by how surprising the move is, not alphabetically.</li>
                  <li>The pedigree GTPI is <strong>computed</strong> from the parent averages using the same round formula as the genomic GTPI — CDCB publishes PA per trait but no PA index. {US_GTPI_NOTE} {US_TPI_TRADEMARK}</li>
                  <li>{US_POUNDS_NOTE}</li>
                </ul>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
