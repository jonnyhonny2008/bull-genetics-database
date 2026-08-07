"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Saved searches for the American pages.
//
// SavedSearch stores a literal {path, query}, so the model already works for a
// US path with no schema change — src/lib/genetic-system.ts carries the system in
// the URL for exactly this reason. What is NOT shared is the write path: these
// actions refuse to touch anything outside /us/, and the Canadian ones stay as
// they are. That way a mistake on one side can never delete or overwrite the
// other side's views, which is the only failure mode a shared table introduces.
//
// Favourites are deliberately absent here. A favourite is a Watchlist row keyed
// (userId, animalId) — animal-level, with no system on it — so a bull starred on
// the Canadian list is already starred on this one. The US list reuses
// src/components/FavouriteStar and its existing action rather than duplicating a
// per-system watchlist, which would let the two sides disagree about the same
// bull. Both lists render with `dynamic = "force-dynamic"`, so the Canadian
// action's revalidatePath calls being Canadian costs this page nothing.
// ---------------------------------------------------------------------------

/** Guard: these actions only ever see American paths. */
function assertUsPath(path: string): string {
  const p = path.trim();
  if (!p.startsWith("/us/")) throw new Error("This action only saves American views.");
  return p;
}

export async function saveUsSearch(name: string, path: string, query: string): Promise<void> {
  const user = currentUser();
  if (!user) throw new Error("You must be signed in.");
  const p = assertUsPath(path);
  const nm = name.trim().slice(0, 80);
  if (!nm) return;
  await prisma.savedSearch.create({ data: { userId: user.uid, name: nm, path: p, query: query.slice(0, 2000) } });
  revalidatePath(p);
}

export async function deleteUsSavedSearch(id: string): Promise<void> {
  const user = currentUser();
  if (!user) throw new Error("You must be signed in.");
  // deleteMany with both guards: the row must be this user's AND American, so a
  // forged id cannot delete someone else's view or a Canadian one.
  await prisma.savedSearch.deleteMany({ where: { id, userId: user.uid, path: { startsWith: "/us/" } } });
  revalidatePath("/us/animals");
}
