// READ-ONLY. Sizes the "fetch missing sires from Lactanet" idea.
//
//   npx dotenv -e .env.production -- npx tsx prisma/audit-missing-sires.ts
//
// A bull whose SIRE is not a held Animal row is paternally blind: we know his
// sire's name but nothing about that sire's parents, so the bull's paternal
// generations 2-3 cannot be screened. Fetching that one sire's pedigree lifts the
// bull from 2/2/2 completeness (0.583) to 2/4/4 (0.833) — across the 0.75 floor.
//
// So: how many DISTINCT sires are missing, and how many bulls does each unblock?
// Sires are shared, so the fetch count is far smaller than the blind-bull count.

import { PrismaClient } from "@prisma/client";
import { parsePedigreeNotes } from "../src/lib/pedigree";

const prisma = new PrismaClient();

/** Same normalisation the relatedness engine uses: strip non-alphanumerics, then
 *  drop leading zeros of the trailing numeric run only. */
function normalizeReg(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  return s.replace(/(\d+)$/, (m) => String(BigInt(m)));
}

async function main() {
  const [ids, peds] = await Promise.all([
    prisma.animalIdentifier.findMany({ where: { active: true }, select: { animalId: true, idValue: true } }),
    prisma.pedigreeReference.findMany({ select: { animalId: true, notes: true } }),
  ]);

  const held = new Set<string>();
  for (const r of ids) { const n = normalizeReg(r.idValue); if (n) held.add(n); }

  const notesByAnimal = new Map<string, string>();
  for (const p of peds) if (p.notes) notesByAnimal.set(p.animalId, p.notes);

  // Only non-archived males are ever mating candidates.
  const bulls = await prisma.animal.findMany({
    where: { archived: false, sex: "M" },
    select: { id: true, primaryName: true },
  });

  let withPedigree = 0, sireNamed = 0, sireHeld = 0, sireMissingReg = 0;
  // missing sire reg -> { name, bulls it would unblock }
  const missing = new Map<string, { name: string | null; blocks: number }>();

  for (const b of bulls) {
    const notes = notesByAnimal.get(b.id);
    if (!notes) continue;
    withPedigree++;
    const anc = parsePedigreeNotes(notes);
    const sire = anc.find((a) => a.relation === "sire");
    if (!sire) continue;
    sireNamed++;
    const key = normalizeReg(sire.reg);
    if (!key) { sireMissingReg++; continue; }
    if (held.has(key)) { sireHeld++; continue; }
    const cur = missing.get(key) ?? { name: sire.name, blocks: 0 };
    cur.blocks++;
    if (!cur.name && sire.name) cur.name = sire.name;
    missing.set(key, cur);
  }

  const ranked = [...missing.entries()].sort((a, b) => b[1].blocks - a[1].blocks);
  const blindBulls = ranked.reduce((s, [, v]) => s + v.blocks, 0);

  console.log(`\nCANDIDATE BULLS (non-archived, male): ${bulls.length}`);
  console.log(`  with a pedigree row:        ${withPedigree}`);
  console.log(`  sire named in pedigree:     ${sireNamed}`);
  console.log(`  sire IS a held animal:      ${sireHeld}  (${((sireHeld / sireNamed) * 100).toFixed(1)}% — these are already screenable)`);
  console.log(`  sire named but NOT held:    ${blindBulls}  (${((blindBulls / sireNamed) * 100).toFixed(1)}% — paternally blind)`);
  console.log(`  sire named without a reg:   ${sireMissingReg}  (unfetchable — no identifier to look up)`);

  console.log(`\nDISTINCT MISSING SIRES TO FETCH: ${ranked.length}`);
  console.log(`  each fetch unblocks on average ${(blindBulls / Math.max(1, ranked.length)).toFixed(1)} bulls`);

  // Coverage gain per fetch, taking the highest-leverage sires first.
  console.log(`\nCOVERAGE GAIN BY FETCH BUDGET (highest-leverage sires first):`);
  let cum = 0;
  const marks = [10, 25, 50, 100, 200, 300, ranked.length];
  let mi = 0;
  for (let i = 0; i < ranked.length; i++) {
    cum += ranked[i][1].blocks;
    while (mi < marks.length && i + 1 === marks[mi]) {
      const pct = ((sireHeld + cum) / sireNamed) * 100;
      console.log(`   after ${String(marks[mi]).padStart(4)} fetches: ${String(cum).padStart(4)} bulls unblocked -> paternal coverage ${pct.toFixed(1)}%`);
      mi++;
    }
  }

  console.log(`\nTOP 15 SIRES BY BULLS UNBLOCKED:`);
  for (const [reg, v] of ranked.slice(0, 15)) {
    console.log(`   ${String(v.blocks).padStart(4)} bulls   ${reg.padEnd(20)} ${v.name ?? ""}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
