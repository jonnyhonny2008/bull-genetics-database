import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { PageHeader, Badge, Table, EmptyState } from "@/components/ui";
import { AnimalFilters } from "./AnimalFilters";
import { SireRolePills, SireClassBadges, BlondinToggle } from "@/components/SireFilters";
import { fmtDate, fmtNum } from "@/lib/format";
import { SEXES, can } from "@/lib/constants";
import { CA_ROSTER } from "@/lib/roster-scope";
import { currentUser } from "@/lib/auth";
import { TRAIT_COLUMNS } from "@/lib/eval-traits";
import { sireRoleWhere, blondinWhere, resolveSort } from "@/lib/sire-class";
import { sireRoleCounts } from "@/lib/sire-rank";
import { getActiveBreeds, getAllSources, getGeneticTraitDefsForFilters } from "@/lib/reference";
import { specialistTraits, specialistFilter, parseLevel, SPECIALIST_LEVELS } from "@/lib/specialists";
import { SpecialistPicker } from "@/components/SpecialistPicker";
import FavouriteStar from "@/components/FavouriteStar";
import SavedSearches from "@/components/SavedSearches";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const listInclude = {
  breed: true,
  // Load the primary registration AND the NAAB code (shown under the name).
  identifiers: { where: { active: true, OR: [{ isPrimary: true }, { idType: "naab" }] }, select: { idType: true, idValue: true, isPrimary: true } },
  evaluations: { where: { isPreferred: true }, take: 1 },
  _count: { select: { evaluations: true, milkRecords: true, classifications: true } },
} satisfies Prisma.AnimalInclude;

type AnimalRow = Prisma.AnimalGetPayload<{ include: typeof listInclude }> & { __sortVal?: number | null };

export default async function AnimalsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  const sp = searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1") || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  // The three shared lineup sorts (LPI / Conformation / birth date) come first;
  // anything else is treated as a trait code with an indexed evaluation column.
  const shared = resolveSort(sp.sort);
  const animalSort = shared?.kind === "animal" ? shared : null;
  const sortCode = shared
    ? (shared.kind === "eval" ? shared.col.toUpperCase() : null)
    : sp.sort && sp.sort !== "name"
      ? sp.sort.toUpperCase()
      : null;
  const sortCol = sortCode ? (TRAIT_COLUMNS[sortCode] ?? null) : null;

  const AND: Prisma.AnimalWhereInput[] = [{ archived: false }];
  if (sp.q) AND.push({ OR: [
    { primaryName: { contains: sp.q, mode: "insensitive" } }, { shortName: { contains: sp.q, mode: "insensitive" } },
    { identifiers: { some: { idValue: { contains: sp.q, mode: "insensitive" } } } },
  ] });
  if (sp.breed) AND.push({ breedId: sp.breed });
  if (sp.sex) AND.push({ sex: sp.sex });
  if (sp.status) AND.push({ currentStatus: sp.status });
  if (sp.country) AND.push({ countryOfOrigin: sp.country });
  // Sire role: proven / genomic / active / inactive, derived from the Lactanet
  // proof codes by prisma/classify-sires.ts and stored on Animal.
  const roleWhere = sireRoleWhere(sp.role);
  if (roleWhere) AND.push(roleWhere as Prisma.AnimalWhereInput);
  // Blondin house bulls (an AnimalRole tag) vs the wider Lactanet population.
  // Pushed into AND, so the trait-sort branch below and the pill counts both
  // honour it without a second condition.
  const blondin = blondinWhere(sp.blondin);
  if (blondin) AND.push(blondin);
  if (sp.source) AND.push({ OR: [
    { identifiers: { some: { sourceId: sp.source } } }, { evaluations: { some: { sourceId: sp.source } } },
    { milkRecords: { some: { sourceId: sp.source } } }, { classifications: { some: { sourceId: sp.source } } },
  ] });
  if (sp.year && /^\d{4}$/.test(sp.year)) AND.push({ birthDate: { gte: new Date(`${sp.year}-01-01T00:00:00Z`), lte: new Date(`${sp.year}-12-31T23:59:59Z`) } });
  if (sp.missingId === "1") AND.push({ identifiers: { none: { isPrimary: true, active: true } } });
  if (sp.pendingReview === "1") AND.push({ reviewItems: { some: { status: { in: ["pending", "conflict_review", "needs_more_info"] } } } });
  if (sp.noProof === "1") AND.push({ evaluations: { none: {} } });
  // "My favourites" — restrict to the signed-in user's watchlist.
  if (sp.fav === "1" && user) AND.push({ watchers: { some: { userId: user.uid } } });

  // Specialists: narrow to bulls that are solidly positive for every picked trait.
  // The bar is set against the whole breed population (a stable reference), then
  // the qualifying ids are folded into the query so paging / sorting / the other
  // filters still apply. Only runs when traits are picked.
  const specCodes = (sp.spec ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const specLevel = parseLevel(sp.specLevel);
  let specResult: Awaited<ReturnType<typeof specialistFilter>> | null = null;
  if (specCodes.length) {
    specResult = await specialistFilter(
      { archived: false, sex: "M", ...(sp.breed ? { breedId: sp.breed } : {}) },
      specCodes,
      specLevel,
    );
    AND.push({ id: { in: specResult.ids } });
  }

  const filterCol = sp.trait ? TRAIT_COLUMNS[sp.trait.toUpperCase()] : null;
  if (filterCol && sp.traitMin && !isNaN(Number(sp.traitMin))) {
    AND.push({ evaluations: { some: { isPreferred: true, [filterCol]: { gte: Number(sp.traitMin) } } } });
  }
  if (sp.classMin && !isNaN(Number(sp.classMin))) AND.push({ classifications: { some: { approvalStatus: "approved", finalScore: { gte: Number(sp.classMin) } } } });
  // THE CANADIAN LINEUP IS NOT THE WHOLE ROSTER. The CDCB import puts an Animal
  // row in this table for every evaluated bull in America, so without this the
  // Canadian list is ~70,000 rows of bulls that have no Canadian proof at all.
  AND.push(CA_ROSTER);
  const where: Prisma.AnimalWhereInput = { AND };

  let total = 0;
  let rows: AnimalRow[] = [];
  let sortLabel: string | null = null;

  if (sortCol) {
    // Sort animals by a trait: order the preferred evaluations by the indexed column.
    const def = await prisma.traitDefinition.findFirst({ where: { domain: "genetic", traitCode: sortCode! } });
    sortLabel = def?.traitName ?? sortCode;
    const evWhere: Prisma.GeneticEvaluationWhereInput = { isPreferred: true, approvalStatus: "approved", [sortCol]: { not: null }, animal: where };
    total = await prisma.geneticEvaluation.count({ where: evWhere });
    const evs = await prisma.geneticEvaluation.findMany({
      where: evWhere, orderBy: { [sortCol]: dir }, skip, take: PAGE_SIZE,
      include: { animal: { include: listInclude } },
    });
    rows = evs.map((ev) => ({ ...ev.animal, __sortVal: (ev as Record<string, unknown>)[sortCol] as number | null }));
  } else {
    // Name (A→Z) or birth date — both are indexed columns on Animal itself.
    const orderBy: Prisma.AnimalOrderByWithRelationInput =
      animalSort?.col === "birthDate" ? { birthDate: dir } : { primaryName: animalSort ? dir : "asc" };
    if (animalSort?.col === "birthDate") sortLabel = "birth date";
    [total, rows] = await Promise.all([
      prisma.animal.count({ where }),
      prisma.animal.findMany({ where, orderBy, skip, take: PAGE_SIZE, include: listInclude }),
    ]);
  }

  // Counts for the quick role pills, respecting every filter except the role itself.
  // One groupBy rather than four counts — the connection pool is the scarce
  // resource here, not the query (see the note in src/lib/db.ts).
  const roleBase: Prisma.AnimalWhereInput = { AND: AND.filter((c) => c !== roleWhere) };
  const roleCounts = await sireRoleCounts(roleBase);

  const [breeds, sources, traitDefs, specTraits] = await Promise.all([
    getActiveBreeds(), getAllSources(), getGeneticTraitDefsForFilters(), specialistTraits(),
  ]);

  // Which of the animals on this page have an import awaiting admin approval
  // (a pending evaluation)? Used to show a "Pending" badge. One query per page.
  const pendingIds = new Set(
    rows.length
      ? (
          await prisma.geneticEvaluation.findMany({
            where: { animalId: { in: rows.map((r) => r.id) }, approvalStatus: "pending" },
            select: { animalId: true }, distinct: ["animalId"],
          })
        ).map((e) => e.animalId)
      : [],
  );

  // The signed-in user's favourites among the shown rows, and their saved views.
  const favIds = user && rows.length
    ? new Set((await prisma.watchlist.findMany({ where: { userId: user.uid, animalId: { in: rows.map((r) => r.id) } }, select: { animalId: true } })).map((w) => w.animalId))
    : new Set<string>();
  const savedSearches = user
    ? await prisma.savedSearch.findMany({ where: { userId: user.uid, path: "/animals" }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, query: true } })
    : [];

  // The current filter state as a querystring (page dropped), for "save this view"
  // and the favourites toggle.
  const currentQuery = (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    return p.toString();
  })();
  const favHref = (() => {
    const p = new URLSearchParams(currentQuery);
    if (sp.fav === "1") p.delete("fav"); else p.set("fav", "1");
    p.delete("page");
    const s = p.toString();
    return s ? `/animals?${s}` : "/animals";
  })();

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") params.set(k, v);
    params.set("page", String(p));
    return `/animals?${params.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Animals"
        subtitle={`${fmtNum(total)} animal${total === 1 ? "" : "s"}${sortLabel ? ` · sorted by ${sortLabel} (${
          animalSort?.col === "birthDate"
            ? dir === "desc" ? "newest first" : "oldest first"
            : dir === "desc" ? "high→low" : "low→high"
        })` : ""}`}
        actions={can(user?.role, "animal:write") ? <Link href="/animals/new" className="btn-primary">+ New animal</Link> : undefined}
      />

      <AnimalFilters breeds={breeds} sources={sources} traitDefs={traitDefs} sp={sp} />
      <BlondinToggle basePath="/animals" sp={sp} />
      <div className="flex flex-wrap items-center gap-3">
        <SpecialistPicker traits={specTraits} />
        {specResult && (
          <span className="mb-3 text-xs text-slate-500">
            {SPECIALIST_LEVELS.find((l) => l.code === specLevel)?.label} for{" "}
            <strong>{specResult.bars.map((b) => b.name).join(", ")}</strong> — {fmtNum(specResult.ids.length)} specialist{specResult.ids.length === 1 ? "" : "s"} of {fmtNum(specResult.poolN)} scored.
          </span>
        )}
      </div>
      <SireRolePills basePath="/animals" sp={sp} counts={roleCounts} />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Link
          href={favHref}
          className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition ${
            sp.fav === "1" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-300 text-slate-600 hover:border-amber-300 hover:text-amber-700"
          }`}
        >
          {sp.fav === "1" ? "★ Showing your favourites" : "☆ My favourites"}
        </Link>
        <SavedSearches path="/animals" currentQuery={currentQuery} searches={savedSearches} />
      </div>

      {rows.length === 0 ? (
        <EmptyState message="No animals match. Try widening your filters or add a new animal.">
          {can(user?.role, "animal:write") && <Link href="/animals/new" className="btn-primary">+ New animal</Link>}
        </EmptyState>
      ) : (
        <>
          <div className="card">
            <Table head={<>
              <th className="th" aria-label="Favourite"></th>
              <th className="th">Name</th>
              <th className="th">Breed</th>
              <th className="th">Sire role</th>
              <th className="th">Primary ID</th>
              <th className="th">{sortLabel ?? "Pref. LPI"}</th>
              <th className="th">Conf</th>
              <th className="th">Born</th>
              <th className="th">Latest proof</th>
              <th className="th" title="April base changes / total proof rounds on file">Rollbacks</th>
              <th className="th">Records</th>
            </>}>
              {rows.map((a) => {
                const primary = a.identifiers.find((i) => i.isPrimary);
                const naab = a.identifiers.find((i) => i.idType === "naab")?.idValue ?? null;
                const preferredEval = a.evaluations[0];
                const shown = sortCol ? a.__sortVal : (preferredEval?.lpi ?? null);
                return (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="td text-center"><FavouriteStar animalId={a.id} initial={favIds.has(a.id)} size="sm" /></td>
                    <td className="td">
                      <Link href={`/animals/${a.id}`} className="link font-medium">{a.primaryName}</Link>
                      {a.shortName && <span className="ml-1 text-xs text-slate-400">({a.shortName})</span>}
                      {pendingIds.has(a.id) && <span className="ml-1" title="Imported record awaiting admin approval"><Badge tone="amber">Pending</Badge></span>}
                      {naab && <span className="mt-0.5 block font-mono text-[10px] text-slate-400" title="NAAB stud code">NAAB {naab}</span>}
                    </td>
                    <td className="td" title={SEXES[a.sex as keyof typeof SEXES] ?? a.sex}>{a.breed?.breedName ?? <span className="text-amber-600">—</span>}</td>
                    <td className="td">
                      <SireClassBadges
                        sireType={a.sireType} proofStatus={a.proofStatus}
                        activityCode={a.latestActivityCode} showRollbacks={false}
                      />
                    </td>
                    <td className="td">{primary ? <span className="font-mono text-xs">{primary.idValue}</span> : <Badge tone="amber">missing</Badge>}</td>
                    <td className="td">{shown != null ? <span className="font-semibold">{shown}</span> : "—"}</td>
                    <td className="td tabular-nums">{preferredEval?.conf ?? "—"}</td>
                    <td className="td text-xs text-slate-500">{a.birthDate ? fmtDate(a.birthDate) : "—"}</td>
                    <td className="td">{preferredEval ? (preferredEval.proofRun ?? fmtDate(preferredEval.evaluationDate)) : <span className="text-slate-400">none</span>}</td>
                    <td className="td text-xs tabular-nums text-slate-500" title={`${a.rollbackCount} April base change${a.rollbackCount === 1 ? "" : "s"} across ${a.proofRoundCount} proof rounds`}>
                      {a.rollbackCount > 0 ? <Badge tone="amber">{a.rollbackCount}×</Badge> : <span className="text-slate-400">0</span>}
                      <span className="ml-1">/ {a.proofRoundCount}</span>
                    </td>
                    <td className="td text-xs text-slate-500">{a._count.evaluations}P · {a._count.milkRecords}M · {a._count.classifications}C</td>
                  </tr>
                );
              })}
            </Table>
          </div>

          {pages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="text-slate-500">Page {fmtNum(page)} of {fmtNum(pages)} · showing {fmtNum(skip + 1)}–{fmtNum(Math.min(page * PAGE_SIZE, total))} of {fmtNum(total)}</div>
              <div className="flex gap-2">
                <PageLink href={qs(1)} disabled={page <= 1} label="« First" />
                <PageLink href={qs(page - 1)} disabled={page <= 1} label="‹ Prev" />
                <PageLink href={qs(page + 1)} disabled={page >= pages} label="Next ›" />
                <PageLink href={qs(pages)} disabled={page >= pages} label="Last »" />
              </div>
            </div>
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
