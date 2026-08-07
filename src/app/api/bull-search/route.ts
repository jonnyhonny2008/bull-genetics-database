import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { CA_ROSTER } from "@/lib/roster-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Typeahead for the comparison pickers.
//
// WHY THIS EXISTS. Both compare pages used to hand the ENTIRE roster to a native
// <datalist> so the browser could filter it without a round-trip. That was a
// sound trade when the Canadian list was a few hundred house bulls — the comment
// in ComparePicker still said "~900 names". It is now 63,052 animals on the
// Canadian side and 68,721 preferred evaluations on the American one, and the
// cost had grown accordingly:
//
//     /compare      10,977 KB of HTML
//     /us/compare    8,035 KB, and the picker query alone took 13.4 s
//
// Every byte of that was shipped on every page view so that somebody could type
// six letters. Searching server-side and returning at most 20 rows turns a
// multi-megabyte page into a small one.
//
// THE TWO SYSTEMS ARE SEPARATE QUERIES AGAINST SEPARATE TABLES, deliberately.
// Canadian bulls live in Animal, American ones in UsAnimal/UsEvaluation, and the
// id each side returns is the id its own compare page expects — a Canadian
// `animal.id` and an American `usAnimalId`. Handing one side's id to the other
// is exactly the bug this endpoint was written alongside: /us/compare filtered
// selected bulls on `animalId` (the optional Canadian bridge, null for 68,581 of
// 68,721 bulls) instead of `usAnimalId`, so every comparison came back empty.
// ---------------------------------------------------------------------------

/** Enough to choose from, few enough to stay small. */
const LIMIT = 20;

export interface BullSearchHit {
  /** The id the CALLING system's compare page expects in ?bulls=. */
  id: string;
  name: string;
  /** NAAB code or registration, shown under the name to tell namesakes apart. */
  hint: string | null;
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!can(user?.role, "compare:read")) {
    return NextResponse.json({ hits: [] as BullSearchHit[] }, { status: 403 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const system = url.searchParams.get("system") === "us" ? "us" : "ca";

  // A blank query returns nothing rather than "the first 20 of 63,052", which
  // would look like a ranked shortlist and is not one.
  if (q.length < 2) return NextResponse.json({ hits: [] as BullSearchHit[] });

  const hits = system === "us" ? await searchUs(q) : await searchCa(q);
  return NextResponse.json({ hits });
}

/** American bulls: one preferred official evaluation each, keyed on usAnimalId. */
async function searchUs(q: string): Promise<BullSearchHit[]> {
  const rows = await prisma.usEvaluation.findMany({
    where: {
      isPreferred: true,
      runKind: "official",
      approvalStatus: "approved",
      OR: [
        { usAnimal: { name: { contains: q, mode: "insensitive" } } },
        { naabCode: { contains: q, mode: "insensitive" } },
        { id17: { contains: q, mode: "insensitive" } },
      ],
    },
    // Ordered by the AMERICAN name. This used to sort on animal.primaryName —
    // the Canadian bridge — which is null for almost every American bull, so the
    // list arrived in no meaningful order at all.
    orderBy: { usAnimal: { name: "asc" } },
    take: LIMIT,
    select: { usAnimalId: true, id17: true, naabCode: true, usAnimal: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.usAnimalId,
    name: r.usAnimal?.name ?? r.id17,
    hint: r.naabCode ? `NAAB ${r.naabCode}` : r.id17,
  }));
}

/** Canadian animals, keyed on Animal.id — the id /compare expects. */
async function searchCa(q: string): Promise<BullSearchHit[]> {
  const rows = await prisma.animal.findMany({
    where: {
      sex: "M",
      archived: false,
      ...CA_ROSTER,
      OR: [
        { primaryName: { contains: q, mode: "insensitive" } },
        { shortName: { contains: q, mode: "insensitive" } },
        { identifiers: { some: { active: true, idValue: { contains: q, mode: "insensitive" } } } },
      ],
    },
    orderBy: { primaryName: "asc" },
    take: LIMIT,
    select: {
      id: true, primaryName: true,
      identifiers: {
        where: { active: true, OR: [{ idType: "naab" }, { isPrimary: true }] },
        select: { idType: true, idValue: true },
        take: 2,
      },
    },
  });
  return rows.map((r) => {
    const naab = r.identifiers.find((i) => i.idType === "naab")?.idValue;
    return {
      id: r.id,
      name: r.primaryName,
      hint: naab ? `NAAB ${naab}` : (r.identifiers[0]?.idValue ?? null),
    };
  });
}
