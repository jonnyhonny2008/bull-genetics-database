// ---------------------------------------------------------------------------
// Fetch the missing SIRES of our bulls from Lactanet, so the mating program can
// actually screen the paternal line.
//
// WHY THIS EXISTS
// A bull whose sire is not a held Animal row is "paternally blind": we know his
// sire's NAME but nothing about that sire's parents, so the bull's paternal
// generations 2-3 cannot be screened for shared ancestry. Measured on production:
// 439 of 935 bulls (47%) are in that state.
//
// Fetching one missing sire yields HIS sire/dam/mgs/mgd, which become the bull's
// paternal grandparents (g2) and one g3 branch — lifting the bull's pedigree
// completeness from 2/2/2 (0.583) to 2/4/4 (0.833), across the 0.75 floor the
// mating report uses. So the bull moves out of "not enough pedigree to check"
// and into real recommendations.
//
// Sires are SHARED, so the work is far smaller than the blind-bull count: only
// 111 distinct sires are missing, averaging 4 bulls unblocked each. The missing
// ones are disproportionately the heavily-used AI sires (Stantons Alligator,
// Farnear Delta-Lambda, …) — which is exactly the population most likely to BE
// the shared ancestor, so this is the highest-value data we can add.
//
// Measured coverage gain, highest-leverage sires first:
//     10 fetches -> 71.0%      50 fetches -> 92.2%
//     25 fetches -> 83.5%     100 fetches -> 98.8%
//
// RESUMABLE. Each run re-derives what is still missing, so a sire fetched last
// run no longer appears. Run it repeatedly with a small --limit until it reports
// nothing left to do.
//
// USAGE
//   # preview only — writes nothing
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server \
//     prisma/backfill-sire-pedigrees.ts
//
//   # fetch the 25 highest-leverage missing sires
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server \
//     prisma/backfill-sire-pedigrees.ts --confirm --limit=25
//
// Storage: ~24 KB per sire (animal + evaluation + profile) — ~2.7 MB for all 111.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { parsePedigreeNotes } from "../src/lib/pedigree";
import { ingestLactanetReg } from "../src/lib/lactanet-ingest";

const prisma = new PrismaClient();

const CONFIRM = process.argv.includes("--confirm");
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  const n = a ? parseInt(a.split("=")[1], 10) : 25;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 25;
})();
/** Courtesy delay between fetches. Lactanet is a partner, not a target. */
const DELAY_MS = 1200;

function normalizeReg(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  return s.replace(/(\d+)$/, (m) => String(BigInt(m)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which sires are named in our bulls' pedigrees but not held as Animal rows? */
async function findMissingSires() {
  const [ids, peds, bulls] = await Promise.all([
    prisma.animalIdentifier.findMany({ where: { active: true }, select: { idValue: true } }),
    prisma.pedigreeReference.findMany({ select: { animalId: true, notes: true } }),
    prisma.animal.findMany({ where: { archived: false, sex: "M" }, select: { id: true } }),
  ]);

  const held = new Set<string>();
  for (const r of ids) { const n = normalizeReg(r.idValue); if (n) held.add(n); }
  const notesByAnimal = new Map(peds.filter((p) => p.notes).map((p) => [p.animalId, p.notes!]));

  const missing = new Map<string, { rawReg: string; name: string | null; blocks: number }>();
  let screenable = 0, named = 0;

  for (const b of bulls) {
    const notes = notesByAnimal.get(b.id);
    if (!notes) continue;
    const sire = parsePedigreeNotes(notes).find((a) => a.relation === "sire");
    if (!sire?.reg) continue;
    named++;
    const key = normalizeReg(sire.reg);
    if (!key) continue;
    if (held.has(key)) { screenable++; continue; }
    const cur = missing.get(key) ?? { rawReg: sire.reg.trim(), name: sire.name, blocks: 0 };
    cur.blocks++;
    if (!cur.name && sire.name) cur.name = sire.name;
    missing.set(key, cur);
  }

  const ranked = [...missing.values()].sort((a, b) => b.blocks - a.blocks);
  return { ranked, screenable, named };
}

async function main() {
  const { ranked, screenable, named } = await findMissingSires();
  const blind = ranked.reduce((s, r) => s + r.blocks, 0);
  const pct = (n: number) => ((n / Math.max(1, named)) * 100).toFixed(1);

  console.log(`\n[sires] bulls with a named sire:  ${named}`);
  console.log(`[sires]   sire already held:       ${screenable}  (${pct(screenable)}% screenable today)`);
  console.log(`[sires]   sire missing:            ${blind}  (${pct(blind)}% paternally blind)`);
  console.log(`[sires] distinct sires to fetch:   ${ranked.length}`);

  if (ranked.length === 0) {
    console.log(`\n[sires] Nothing to do — every named sire is already held.\n`);
    return;
  }

  const batch = ranked.slice(0, LIMIT);
  const wouldUnblock = batch.reduce((s, r) => s + r.blocks, 0);

  console.log(`\n[sires] NEXT ${batch.length} (highest leverage first):`);
  for (const r of batch.slice(0, 15)) {
    console.log(`         ${String(r.blocks).padStart(3)} bulls   ${r.rawReg.padEnd(20)} ${r.name ?? ""}`);
  }
  if (batch.length > 15) console.log(`         … and ${batch.length - 15} more`);
  console.log(`\n[sires] this batch would unblock ${wouldUnblock} bulls -> paternal coverage ${pct(screenable + wouldUnblock)}%`);

  if (!CONFIRM) {
    console.log(`\n[sires] DRY RUN — nothing written.`);
    console.log(`[sires] Re-run with --confirm to fetch. Add --limit=N to change the batch size.\n`);
    return;
  }

  console.log(`\n[sires] fetching ${batch.length} sires from Lactanet (${DELAY_MS}ms apart)…\n`);
  let ok = 0, failed = 0, unblocked = 0;

  for (const [i, r] of batch.entries()) {
    const tag = `[${String(i + 1).padStart(3)}/${batch.length}]`;
    try {
      const res = await ingestLactanetReg(r.rawReg, undefined);
      if (res.error) {
        failed++;
        console.log(`${tag} FAILED  ${r.rawReg}  — ${res.error}`);
      } else {
        ok++;
        unblocked += r.blocks;
        console.log(`${tag} ok      ${r.rawReg}  ${res.name ?? r.name ?? ""} (unblocks ${r.blocks})`);
      }
    } catch (e) {
      failed++;
      console.log(`${tag} ERROR   ${r.rawReg}  — ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    if (i < batch.length - 1) await sleep(DELAY_MS);
  }

  const after = await findMissingSires();
  const nowBlind = after.ranked.reduce((s, x) => s + x.blocks, 0);

  console.log(`\n[sires] DONE — fetched ${ok}, failed ${failed}, bulls unblocked ${unblocked}`);
  console.log(`[sires] paternal coverage now ${((after.screenable / Math.max(1, after.named)) * 100).toFixed(1)}%`);
  console.log(`[sires] still missing: ${after.ranked.length} sires blocking ${nowBlind} bulls`);
  if (after.ranked.length) console.log(`[sires] run again to continue.\n`);
  else console.log(`[sires] complete — every named sire is now held.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
