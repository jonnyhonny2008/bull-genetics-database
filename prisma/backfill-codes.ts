// ---------------------------------------------------------------------------
// One-time backfill: the proof rounds already in the database were imported
// before the Lactanet status codes were being captured. Re-read the staged CDN
// CSVs and fill in activityCode / officialCode / daughters / herds / genotyped /
// sireType on the matching GeneticEvaluation rows, then re-derive the per-sire
// classification.
//
// Matching key is (animalId, proofRun) — the same key the importer dedupes on.
// Idempotent: re-running just rewrites the same values.
//
// Usage: npx tsx prisma/backfill-codes.ts [stageDir]
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import readline from "readline";
import { parseHeader, parseRow } from "../src/lib/lactanet";
import { classifyRound, isGenotyped } from "../src/lib/sire-class";
import { classifySires } from "./classify-sires";

const prisma = new PrismaClient();
const stageDir = process.argv[2] || path.join(process.env.IMPORTS_DIR || "./imports", "cdn");
const CHUNK = 1500;

function runLabel(gerun: string | null): string | null {
  const m = (gerun ?? "").match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const yy = parseInt(m[1]);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  const month = Math.min(12, Math.max(1, parseInt(m[2])));
  const name = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month];
  return `${name} ${year}`;
}

interface Patch { aid: string; run: string; act: string | null; off: string | null; dtrs: number | null; herds: number | null; geno: boolean; stype: string }

// Bulk UPDATE ... FROM jsonb_to_recordset — one round-trip per chunk instead of
// one per row (matters a lot over the Supabase session pooler).
async function applyChunk(rows: Patch[]) {
  if (!rows.length) return;
  await prisma.$executeRawUnsafe(
    `UPDATE "GeneticEvaluation" g SET
       "activityCode" = v."act", "officialCode" = v."off", "daughters" = v."dtrs",
       "herds" = v."herds", "genotyped" = v."geno", "sireType" = v."stype"
     FROM jsonb_to_recordset($1::jsonb)
       AS v("aid" text, "run" text, "act" text, "off" text, "dtrs" int, "herds" int, "geno" boolean, "stype" text)
     WHERE g."animalId" = v."aid" AND g."proofRun" = v."run"`,
    JSON.stringify(rows),
  );
}

async function main() {
  if (!fs.existsSync(stageDir)) { console.error(`[backfill] staging dir not found: ${stageDir}`); process.exit(1); }
  const files = fs.readdirSync(stageDir).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(stageDir, f));

  const regToAnimal = new Map<string, string>();
  for (const r of await prisma.animalIdentifier.findMany({
    where: { idType: { in: ["registration_ca", "registration_us", "registration_int"] } },
    select: { idValue: true, animalId: true },
  })) regToAnimal.set(r.idValue.toUpperCase(), r.animalId);
  console.log(`[backfill] ${files.length} files · ${regToAnimal.size} known registrations`);

  // The same (bull, run) appears in many monthly files; keep one patch per key.
  const seen = new Set<string>();
  let buf: Patch[] = [];
  let matched = 0, unmatched = 0, rows = 0, fileNo = 0;

  for (const file of files) {
    fileNo++;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let idx: Map<string, number> | null = null;
    for await (const line of rl) {
      if (!idx) { idx = parseHeader(line); continue; }
      const bull = parseRow(line.split(","), idx);
      rows++;
      if (!bull) continue;
      const run = runLabel(bull.proofRun);
      const aid = regToAnimal.get(bull.registrationNumber.toUpperCase());
      if (!run || !aid) { unmatched++; continue; }
      const key = `${aid}|${run}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buf.push({
        aid, run,
        act: bull.activityCode, off: bull.officialCode,
        dtrs: bull.daughters != null ? Math.round(bull.daughters) : null,
        herds: bull.herds != null ? Math.round(bull.herds) : null,
        geno: isGenotyped(bull.activityCode),
        stype: classifyRound(bull),
      });
      matched++;
      if (buf.length >= CHUNK) { await applyChunk(buf); buf = []; }
    }
    rl.close();
    if (fileNo % 50 === 0) process.stdout.write(`\r[backfill] files ${fileNo}/${files.length} · rounds patched ${matched}   `);
  }
  await applyChunk(buf);

  console.log(`\n[backfill] rows read ${rows} · distinct rounds patched ${matched} · rows with no matching bull/run ${unmatched}`);

  const stats = await classifySires(prisma);
  console.log(`[backfill] latest round on file: ${stats.latestRound ?? "—"}`);
  console.log(`[backfill] active ${stats.active} · inactive ${stats.inactive} · proven ${stats.proven} · genomic ${stats.genomic}`);

  const codes = (await prisma.$queryRawUnsafe(`
    SELECT "activityCode" AS code, COUNT(*)::int AS n
    FROM "GeneticEvaluation" GROUP BY "activityCode" ORDER BY n DESC
  `)) as { code: string | null; n: number }[];
  console.log("[backfill] proof-activity codes across all rounds:", codes.map((c) => `${c.code ?? "(none)"}=${c.n}`).join(" "));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
