// Repair: write the missing PedigreeReference row for animals whose profile we
// already hold.
//
//   # preview — writes nothing
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server \
//     prisma/backfill-pedigree-notes.ts
//   # write
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server \
//     prisma/backfill-pedigree-notes.ts --confirm
//
// WHY
// The relatedness engine reads pedigree from PedigreeReference.notes and
// nowhere else. The proof-file importer writes that row; the live Lactanet
// profile fetch did not — it stored the family tree on Animal.holsteinProfileJson
// and stopped. So every sire fetched by backfill-sire-pedigrees.ts to close a
// pedigree gap was saved without a readable pedigree, and the gap it was fetched
// to close stayed open. The audit shows it plainly: "sire is a HELD animal WITH
// notes" barely moved after 111 sires were fetched.
//
// storeHolsteinProfile now writes the row itself, so this is only needed for
// animals ingested before that fix. Idempotent — an animal that already has a
// parseable pedigree from any source is skipped.

import { PrismaClient } from "@prisma/client";
import { parseHolsteinProfileJson } from "../src/lib/holstein-parse";
import { parsePedigreeNotes, pedigreeNotesFromFamilyTree } from "../src/lib/pedigree";

const prisma = new PrismaClient();
const CONFIRM = process.argv.includes("--confirm");

async function main() {
  const source = await prisma.source.findFirst({ where: { sourceName: "LactanetGen" }, select: { sourceId: true } });
  if (!source) throw new Error("LactanetGen source row not found.");

  const animals = await prisma.animal.findMany({
    where: { holsteinProfileJson: { not: null } },
    select: {
      id: true, primaryName: true, holsteinProfileJson: true,
      pedigreeRefs: { select: { notes: true } },
    },
  });
  console.log(`  animals with a stored profile: ${animals.length}`);

  const todo: { id: string; name: string; notes: string; from: number; to: number }[] = [];
  let alreadyOk = 0, noTree = 0;

  /** Ancestors that carry a registration — the only ones the engine can match on. */
  const usable = (notes: string | null) => parsePedigreeNotes(notes).filter((x) => x.reg).length;

  for (const a of animals) {
    const best = Math.max(0, ...a.pedigreeRefs.map((p) => usable(p.notes)));
    const profile = parseHolsteinProfileJson(a.holsteinProfileJson);
    const tree = profile?.familyTree ?? [];
    const notes = tree.length ? pedigreeNotesFromFamilyTree(tree) : null;
    if (!notes) { noTree++; continue; }
    // Write only when the family tree is RICHER than what we already hold.
    // Skipping on "has any pedigree at all" was too blunt: an animal whose
    // stored line names only sire and dam is below the certification floor even
    // though its profile carries the maternal grandparents too. The corpus keeps
    // the richest line per animal, so adding a better one is always safe.
    if (usable(notes) <= best) { alreadyOk++; continue; }
    todo.push({ id: a.id, name: a.primaryName, notes, from: best, to: usable(notes) });
  }

  console.log(`  already as good or better: ${alreadyOk}`);
  console.log(`  no usable family tree to convert: ${noTree}`);
  console.log(`  would write: ${todo.length}\n`);
  for (const t of todo.slice(0, 5)) {
    console.log(`    ${t.name.slice(0, 30).padEnd(32)} ${t.from} -> ${t.to} ancestors`);
  }
  if (todo.length > 5) console.log(`    … and ${todo.length - 5} more`);

  if (!CONFIRM) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --confirm.`);
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  for (const t of todo) {
    await prisma.pedigreeReference.create({
      data: {
        animalId: t.id, sourceId: source.sourceId,
        displayStatus: "linked", lastCheckedAt: new Date(), notes: t.notes,
      },
    });
    written++;
    if (written % 25 === 0) console.log(`  … ${written}/${todo.length}`);
  }
  console.log(`\n  wrote ${written} pedigree reference rows.`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
