"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";

// Per-user favourites (a watchlist) and saved searches. Every action is scoped to
// the signed-in user — a user can only touch their own rows.

export async function toggleFavourite(animalId: string): Promise<{ favourited: boolean }> {
  const user = currentUser();
  if (!user) throw new Error("You must be signed in.");
  const existing = await prisma.watchlist.findUnique({
    where: { userId_animalId: { userId: user.uid, animalId } },
    select: { id: true },
  });
  if (existing) {
    await prisma.watchlist.delete({ where: { id: existing.id } });
    revalidatePath("/animals");
    revalidatePath(`/animals/${animalId}`);
    return { favourited: false };
  }
  await prisma.watchlist.create({ data: { userId: user.uid, animalId } });
  revalidatePath("/animals");
  revalidatePath(`/animals/${animalId}`);
  return { favourited: true };
}

export async function saveSearch(name: string, path: string, query: string): Promise<void> {
  const user = currentUser();
  if (!user) throw new Error("You must be signed in.");
  const nm = name.trim().slice(0, 80);
  if (!nm) return;
  await prisma.savedSearch.create({ data: { userId: user.uid, name: nm, path, query: query.slice(0, 2000) } });
  revalidatePath(path);
}

export async function deleteSavedSearch(id: string): Promise<void> {
  const user = currentUser();
  if (!user) throw new Error("You must be signed in.");
  // deleteMany with the userId guard so a user can only delete their own.
  await prisma.savedSearch.deleteMany({ where: { id, userId: user.uid } });
  revalidatePath("/animals");
}
