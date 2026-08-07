import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, Badge, EmptyState, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { US_KEY_TRAITS, US_SORTABLE_KEY_TRAITS, formatUsTrait } from "@/lib/us-cdcb/key-traits";
import { usSpecialists, parseUsSpecialistCodes, parseUsSpecialistLevel, US_SPECIALIST_TRAITS, type UsSpecialistLevel } from "@/lib/us-cdcb/specialists";
import { SpecialistPicker } from "@/components/SpecialistPicker";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";
import { usRoundLabel } from "@/lib/us-cdcb/proof-change";
import { usRoleWhere, usSearchWhere, usFavouriteWhere, usRoleCounts, usLatestStatusRound } from "@/lib/us-cdcb/list-filters";
// Favourites are ANIMAL-level (a Watchlist row keyed userId+animalId, with no
// system on it), so this is the same star and the same action the Canadian list
// uses — a bull starred there is already starred here. Duplicating it per system
// would let the two sides disagree about the same bull.
import FavouriteStar from "@/components/FavouriteStar";
import UsSavedSearches from "./UsSavedSearches";
import { UsAnimalSearch, UsRolePills, UsFavouritesToggle } from "./UsListFilters";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** CDCB's AI-status codes, in the file's own vocabulary. */
const AI_STATUS_LABEL: Record<string, string> = { A: "Active AI", G: "Marketed young", F: "Foreign" };

// The American lineup. Reads UsEvaluation — never GeneticEvaluation — so a
// Canadian number can never leak into this table, which would be the worst
// possible bug here (PTAs in pounds sitting in a column labelled like an EBV in kg).

export default async function UsAnimalsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  const sp = searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1") || 1);
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const breed = (sp.breed ?? "").toUpperCase();
  const q = (sp.q ?? "").trim();
  const role = sp.role ?? "";
  const favUserId = sp.fav === "1" && user ? user.uid : null;
  // SPECIALISTS IS A SEARCH, NOT A PLACE. It narrows this list to the bulls that
  // are solidly positive for every picked trait, so it composes with breed, role,
  // favourites, sorting and paging instead of being a separate ranked page that
  // silently ignores them.
  const specCodes = parseUsSpecialistCodes(sp.spec);
  const specLevel = parseUsSpecialistLevel(sp.specLevel);

  // Only rankable traits may be sorted on — rump angle has an intermediate
  // optimum, so "highest first" would be a meaningless ordering.
  const sortTrait = US_SORTABLE_KEY_TRAITS.find((t) => t.code === (sp.sort ?? "GTPI").toUpperCase())
    ?? US_SORTABLE_KEY_TRAITS[0];

  let rows: Awaited<ReturnType<typeof loadRows>> = {
    list: [], total: 0, roleCounts: {}, statusRound: null, aiByAnimal: new Map<string, string>(), spec: null, missingTables: false,
  };
  try {
    rows = await loadRows({ page, dir, breed, q, role, favUserId, sortColumn: sortTrait.column, specCodes, specLevel });
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, say so
    // plainly rather than rendering a 500 — this is a setup state, not a fault.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) {
      rows.missingTables = true;
    } else throw e;
  }

  // Watchlist and SavedSearch are Canadian-era tables that carry no system, so
  // neither query can hit the missing-US-tables case above.
  const favIds = user && rows.list.length
    ? new Set(
        (await prisma.watchlist.findMany({
          where: { userId: user.uid, animalId: { in: rows.list.map((r) => r.animalId).filter((x): x is string => !!x) } },
          select: { animalId: true },
        })).map((w) => w.animalId),
      )
    : new Set<string>();
  const savedSearches = user && !rows.missingTables
    ? await prisma.savedSearch.findMany({
        // SavedSearch stores a literal {path, query}, so the American views live
        // under their own path with no schema change.
        where: { userId: user.uid, path: "/us/animals" },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, query: true },
      })
    : [];

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/us/animals?${p.toString()}`;
  };

  // The current filter state as a querystring (page dropped) — what "save this
  // view" stores, so a saved view reopens on page 1 with the same filters.
  const currentQuery = (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    return p.toString();
  })();

  const filtered = Boolean(q || breed || role || favUserId);
  const pages = Math.max(1, Math.ceil(rows.total / PAGE_SIZE));
  const skip = (page - 1) * PAGE_SIZE;

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
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run us:finish</pre>
          <p className="mt-3 text-xs text-slate-500">
            Both are additive — no existing Canadian table is touched.
          </p>
        </Card>
      ) : rows.total === 0 && !filtered ? (
        <EmptyState message="No US evaluations imported yet. Run a CDCB round through the importer to populate this list." />
      ) : (
        <>
          <UsAnimalSearch sp={sp} />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Breed</span>
            <Link href={qs({ breed: undefined, page: undefined })} className={`rounded-full border px-3 py-1 text-xs font-medium ${!breed ? "border-brand-400 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-600 hover:border-brand-300"}`}>All breeds</Link>
            {CDCB_BREEDS.map((b) => (
              <Link key={b} href={qs({ breed: b, page: undefined })} className={`rounded-full border px-3 py-1 text-xs font-medium ${breed === b ? "border-brand-400 bg-brand-50 text-brand-800" : "border-slate-300 text-slate-600 hover:border-brand-300"}`}>{b}</Link>
            ))}
          </div>

          <UsRolePills sp={sp} counts={rows.roleCounts} statusRound={rows.statusRound} />

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SpecialistPicker traits={US_SPECIALIST_TRAITS.map((t) => ({ code: t.code, name: t.name, group: t.group }))} />
            <UsFavouritesToggle sp={sp} signedIn={Boolean(user)} />
            {user && <UsSavedSearches path="/us/animals" currentQuery={currentQuery} searches={savedSearches} />}
          </div>

          {/* What the bar actually was, stated in the results rather than hidden in
              the picker: a specialist search is only as meaningful as the pool it
              was measured against. */}
          {rows.spec && (
            <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-900">
              <strong>Specialist search.</strong> {rows.spec.rows.length} of {fmtNum(rows.spec.scoredN)} bulls in the
              official {breed || "all-breed"} pool are solidly positive for {specCodes.join(", ")}
              {rows.spec.bars.length > 0 && (
                <> — the bar is {rows.spec.bars.filter((b) => b.threshold != null).map((b) => `${b.code} ≥ ${b.threshold!.toFixed(2)}`).join(", ")}</>
              )}
              . Every other filter, the sort and the paging still apply.
              {rows.spec.truncated && <> Only the strongest matches are shown.</>}
            </div>
          )}

          {rows.list.length === 0 ? (
            <EmptyState message="No bulls match. Try widening the search, breed or role." />
          ) : (
            <>
              <div className="card">
                <Table head={<>
                  <th className="th" aria-label="Favourite"></th>
                  <th className="th">Bull</th>
                  <th className="th">Breed</th>
                  <th className="th">Role</th>
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
                  {rows.list.map((r) => {
                    const ai = rows.aiByAnimal.get(r.id17) ?? null;
                    return (
                      <tr key={r.usEvaluationId} className="hover:bg-slate-50">
                        <td className="td text-center">{r.animalId ? <FavouriteStar animalId={r.animalId} initial={favIds.has(r.animalId)} size="sm" /> : null}</td>
                        <td className="td">
                          <Link href={`/us/animals/${r.usAnimalId}`} className="link font-medium">{r.usAnimal.name ?? r.id17}</Link>
                          {r.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {r.naabCode}</span>}
                        </td>
                        <td className="td text-xs text-slate-500">{r.evalBreed ?? "—"}</td>
                        <td className="td">
                          <div className="flex flex-wrap items-center gap-1">
                            {r.isPtaMilk != null && (
                              <span title={r.isPtaMilk
                                ? "CDCB reports this bull's PRODUCTION traits from daughter records. His calving traits may still be parent-average."
                                : "CDCB reports this bull's PRODUCTION traits from genomics and parent average, not daughters."}>
                                <Badge tone={r.isPtaMilk ? "green" : "blue"}>{r.isPtaMilk ? "Proven" : "PA"}</Badge>
                              </span>
                            )}
                            {ai && (
                              <span title={`CDCB AI status ${ai} in the ${usRoundLabel(rows.statusRound)} status file`}>
                                <Badge tone={ai === "A" ? "brand" : "slate"}>{AI_STATUS_LABEL[ai] ?? ai}</Badge>
                              </span>
                            )}
                          </div>
                        </td>
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
                    );
                  })}
                </Table>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
                Association USA formula in force for each round. It is not an official Holstein Association USA
                publication and is typically within ±3 points of the published figure. TPI is a registered
                trademark of Holstein Association USA. Rump Angle has an intermediate optimum and is shown but
                not ranked. All yield values are PTAs in pounds.
              </p>

              {pages > 1 && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div className="text-slate-500">
                    Page {fmtNum(page)} of {fmtNum(pages)} · showing {fmtNum(skip + 1)}–{fmtNum(Math.min(page * PAGE_SIZE, rows.total))} of {fmtNum(rows.total)}
                  </div>
                  <div className="flex gap-2">
                    <PageLink href={qs({ page: 1 })} disabled={page <= 1} label="« First" />
                    <PageLink href={qs({ page: page - 1 })} disabled={page <= 1} label="‹ Prev" />
                    <PageLink href={qs({ page: page + 1 })} disabled={page >= pages} label="Next ›" />
                    <PageLink href={qs({ page: pages })} disabled={page >= pages} label="Last »" />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function PageLink({ href, disabled, label }: { href: string; disabled: boolean; label: string }) {
  if (disabled) return <span className="btn-secondary btn-sm cursor-not-allowed opacity-40">{label}</span>;
  return <Link href={href} className="btn-secondary btn-sm">{label}</Link>;
}

async function loadRows(opts: {
  page: number;
  dir: "asc" | "desc";
  breed: string;
  q: string;
  role: string;
  favUserId: string | null;
  sortColumn: string;
  specCodes: string[];
  specLevel: UsSpecialistLevel;
}) {
  // The AI-status file is published per round, so "active" means active in the
  // latest file we hold — not "has ever been marketed".
  const statusRound = await usLatestStatusRound();

  const AND: Prisma.UsEvaluationWhereInput[] = [{ isPreferred: true, approvalStatus: "approved" }];
  if (opts.breed) AND.push({ evalBreed: opts.breed });
  const search = usSearchWhere(opts.q);
  if (search) AND.push(search);
  if (opts.favUserId) AND.push(usFavouriteWhere(opts.favUserId));
  const roleWhere = usRoleWhere(opts.role, statusRound);
  if (roleWhere) AND.push(roleWhere);

  // The bar is set against the whole official pool for the breed — a stable
  // reference — and the qualifying ids are folded back into the query so every
  // other filter, the sort and the paging still apply.
  let spec: Awaited<ReturnType<typeof usSpecialists>> | null = null;
  if (opts.specCodes.length) {
    spec = await usSpecialists({ codes: opts.specCodes, level: opts.specLevel, breed: opts.breed || undefined, limit: 5000 });
    AND.push({ usAnimalId: { in: spec.rows.map((r) => r.animalId) } });
  }
  const where: Prisma.UsEvaluationWhereInput = { AND };

  // The pill counts answer "what would this pill give me", so they honour every
  // filter EXCEPT the role itself — otherwise picking one role would zero the
  // other four and there would be no way back except "All".
  const roleBase: Prisma.UsEvaluationWhereInput = { AND: AND.filter((c) => c !== roleWhere) };

  const [total, list, roleCounts] = await Promise.all([
    prisma.usEvaluation.count({ where }),
    prisma.usEvaluation.findMany({
      where,
      orderBy: { [opts.sortColumn]: { sort: opts.dir, nulls: "last" } },
      skip: (opts.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        usEvaluationId: true, usAnimalId: true, id17: true, animalId: true, evalBreed: true, naabCode: true,
        roundCode: true, runKind: true, tpi: true, tpiFormulaVersion: true, isPtaMilk: true,
        nmDollar: true, ptat: true, milk: true, rpa: true, dpr: true, ccr: true,
        usAnimal: { select: { name: true, id17: true, animalId: true } },
      },
    }),
    usRoleCounts(roleBase, statusRound),
  ]);

  // One status lookup for the whole page, pinned to the same round the pills
  // filter on so a badge and a pill can never disagree.
  const aiRows = list.length && statusRound
    ? await prisma.usAiStatus.findMany({
        where: { roundCode: statusRound, id17: { in: list.map((r) => r.id17) } },
        select: { id17: true, code: true },
      })
    : [];
  const aiByAnimal = new Map<string, string>();
  for (const a of aiRows) aiByAnimal.set(a.id17, a.code);

  return { list, total, roleCounts, statusRound, aiByAnimal, spec, missingTables: false };
}
