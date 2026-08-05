// Registered names change over time (new prefix, registry correction). Take the
// name from each registration's MOST RECENT proof file as the true one, and set
// it on the Animal. Works off the Blondin source files (the round comes from the
// file name, via classifyProofFile), newest round wins.
//
//   npx tsx prisma/backfill-names.ts                    (dry run)
//   npx dotenv -e .env.production -- npx tsx prisma/backfill-names.ts --confirm
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { classifyProofFile } from "../src/lib/proof-file-kind";

const prisma = new PrismaClient();
const ROOT = process.env.BLONDIN_ROOT || "C:/Users/Jonathan/Blondin/Blondin Sires - Genetics";
const CONFIRM = process.argv.includes("--confirm");

function walk(d: string, out: string[] = []): string[] {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const x of e) { const f = path.join(d, x.name); x.isDirectory() ? walk(f, out) : out.push(f); }
  return out;
}
const clean = (s: string | undefined) => (s ?? "").trim();

async function main() {
  // Files that carry bull registered names: official, interim, and private-stud
  // proof files. Sort ascending by GERUN so the newest round overwrites last.
  const files = walk(ROOT)
    .filter((f) => /\.csv$/i.test(f))
    .map((f) => ({ f, id: classifyProofFile(f) }))
    .filter((x) => (x.id.family === "official" || x.id.family === "interim" || x.id.family === "private") && x.id.gerun)
    .sort((a, b) => (a.id.gerun! < b.id.gerun! ? -1 : 1));

  // reg -> {name, shortName} from the newest file that mentions it.
  const latest = new Map<string, { name: string; shortName: string | null; gerun: string }>();
  for (const { f, id } of files) {
    let lines: string[];
    try { lines = fs.readFileSync(f, "latin1").split(/\r?\n/); } catch { continue; }
    if (lines.length < 2) continue;
    const h = lines[0].split(",").map((s) => s.trim());
    const iReg = h.indexOf("REGISTRATION NUMBER");
    const iName = h.indexOf("REGISTERED NAME");
    const iShort = h.indexOf("SHORT NAME");
    if (iReg < 0 || iName < 0) continue;
    for (const l of lines.slice(1)) {
      const c = l.split(",");
      const reg = clean(c[iReg]).toUpperCase();
      const name = clean(c[iName]);
      if (!reg || !name) continue;
      const cur = latest.get(reg);
      // Ascending file order means a later assignment is a same-or-newer round.
      if (!cur || id.gerun! >= cur.gerun) latest.set(reg, { name, shortName: iShort >= 0 ? clean(c[iShort]) || null : null, gerun: id.gerun! });
    }
  }
  console.log(`[names] scanned ${files.length} files · ${latest.size} distinct registrations`);

  // Map registrations to animals, compare, collect changes.
  const idRows = await prisma.animalIdentifier.findMany({
    where: { idType: { in: ["registration_ca", "registration_us", "registration_int"] } },
    select: { idValue: true, animalId: true },
  });
  const animals = await prisma.animal.findMany({ select: { id: true, primaryName: true, shortName: true } });
  const byId = new Map(animals.map((a) => [a.id, a]));

  const patches: { id: string; name: string; short: string | null; from: string }[] = [];
  for (const r of idRows) {
    const truth = latest.get(r.idValue.toUpperCase());
    const a = byId.get(r.animalId);
    if (!truth || !a) continue;
    if (a.primaryName !== truth.name) {
      patches.push({ id: a.id, name: truth.name, short: truth.shortName ?? a.shortName, from: a.primaryName });
    }
  }
  console.log(`[names] animals whose stored name is stale: ${patches.length}`);
  for (const p of patches.slice(0, 25)) console.log(`   "${p.from}"  →  "${p.name}"`);
  if (patches.length > 25) console.log(`   … and ${patches.length - 25} more`);

  if (!CONFIRM) { console.log("\n[names] dry run — nothing written. Re-run with --confirm."); return; }
  for (const p of patches) {
    await prisma.animal.update({ where: { id: p.id }, data: { primaryName: p.name, shortName: p.short } });
  }
  console.log(`\n[names] updated ${patches.length} animals.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
