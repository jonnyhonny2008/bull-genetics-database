// ---------------------------------------------------------------------------
// Bulk-import Holstein.ca animal scrapes into the database.
//
// Input: one or more JSON batch files produced by scripts/holstein-extract.js
// (an array of raw extracts: identity/pedigree text + the Genetics-page tables).
// Each record is parsed (src/lib/holstein-parse) and upserted (src/lib/holstein-
// import) into Animal + identifiers + genomic evaluation + classification +
// pedigree. Then the preferred-record flags and derived sire columns are
// recomputed, exactly like prisma/import-cdn.ts.
//
// Usage:
//   npm run import:holstein:demo              # all JSON in imports/holstein/
//   npm run import:holstein:demo -- path.json # a specific batch file
//   (or the :prod variants — see package.json)
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { parseHolsteinExtract, type HolsteinRawExtract } from "../src/lib/holstein-parse";
import { importParsedHolstein } from "../src/lib/holstein-import";
import { classifySires } from "./classify-sires";
import { computeRollbackRatings } from "./compute-rollback";
import { computePedigreeIndexAll } from "./compute-pedigree-index";

const prisma = new PrismaClient();

function resolveFiles(arg: string | undefined): string[] {
  const defaultDir = process.env.IMPORTS_DIR ? path.join(process.env.IMPORTS_DIR, "holstein") : path.join("imports", "holstein");
  if (arg && fs.existsSync(arg) && fs.statSync(arg).isFile()) return [arg];
  const dir = arg && fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? arg : defaultDir;
  if (!fs.existsSync(dir)) {
    console.error(`[holstein] no batch file/dir found. Looked in: ${arg ?? defaultDir}`);
    console.error(`[holstein] Put the scraper's holstein-batch-*.json into ${defaultDir}/ or pass a path.`);
    process.exit(1);
  }
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).map((f) => path.join(dir, f));
}

async function main() {
  const files = resolveFiles(process.argv[2]);
  if (!files.length) { console.error("[holstein] no .json batch files to import."); process.exit(1); }
  console.log(`[holstein] importing ${files.length} batch file(s)`);

  const breed = await prisma.breed.findUnique({ where: { breedCode: "HO" } });
  const lactanet = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" } });
  const holCanada = await prisma.source.findUnique({ where: { sourceName: "Holstein Canada" } });
  const admin = await prisma.user.findFirst({ where: { role: "admin" } });
  if (!holCanada) console.warn("[holstein] WARNING: Source 'Holstein Canada' not found — run seed:config first.");

  let total = 0, created = 0, evals = 0, cls = 0, errors = 0, skipped = 0;

  for (const file of files) {
    let parsedFile: unknown;
    try { parsedFile = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.error(`[holstein] cannot read ${file}: ${(e as Error).message}`); continue; }
    const records: HolsteinRawExtract[] = Array.isArray(parsedFile) ? (parsedFile as HolsteinRawExtract[]) : [parsedFile as HolsteinRawExtract];

    const capture = await prisma.sourceCapture.create({
      data: {
        sourceId: holCanada?.sourceId, captureType: "browser_lookup", originalFileName: path.basename(file),
        capturedById: admin?.id, extractionStatus: "extracted", confidenceScore: 0.95,
        notes: `Holstein.ca batch scrape — ${records.length} animal(s) from ${path.basename(file)}`,
      },
    });

    for (const rec of records) {
      if ((!rec.mainText || !rec.mainText.trim()) && rec.error) { skipped++; console.warn(`  – ${rec.reg ?? "?"} skipped (${rec.error})`); continue; }
      try {
        const parsed = parseHolsteinExtract(rec);
        const res = await importParsedHolstein(prisma, parsed, rec.reg ?? "", {
          breedId: breed?.breedId ?? null, lactanetSourceId: lactanet?.sourceId ?? null, holCanadaSourceId: holCanada?.sourceId ?? null,
          userId: admin?.id, captureId: capture.captureId, animalIdParam: rec.animalId ?? null,
        });
        total++; if (res.created) created++; if (res.evaluationWritten) evals++; if (res.classificationWritten) cls++;
        console.log(`  ✓ ${res.regNo} ${res.created ? "NEW" : "upd"} · traits ${res.traitCount}${res.warnings.length ? "  ⚠ " + res.warnings.join("; ") : ""}`);
      } catch (e) {
        errors++; console.warn(`  ✗ ${rec.reg ?? "?"} — ${(e as Error).message}`);
      }
    }
  }

  // --- Enforce one preferred genomic evaluation per animal (latest approved) ---
  await prisma.$executeRawUnsafe(`UPDATE "GeneticEvaluation" SET "isPreferred" = false WHERE "isPreferred" = true`);
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT "evaluationId", ROW_NUMBER() OVER (PARTITION BY "animalId"
        ORDER BY "evaluationDate" DESC, "lpi" DESC NULLS LAST, "evaluationId" DESC) AS rn
      FROM "GeneticEvaluation" WHERE "approvalStatus" = 'approved'
    )
    UPDATE "GeneticEvaluation" g SET "isPreferred" = true FROM ranked r
    WHERE g."evaluationId" = r."evaluationId" AND r.rn = 1
  `);
  // --- One preferred classification per animal (latest approved) ---
  await prisma.$executeRawUnsafe(`UPDATE "ClassificationRecord" SET "isPreferred" = false WHERE "isPreferred" = true`);
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT "classificationId", ROW_NUMBER() OVER (PARTITION BY "animalId"
        ORDER BY "classificationDate" DESC, "classificationId" DESC) AS rn
      FROM "ClassificationRecord" WHERE "approvalStatus" = 'approved'
    )
    UPDATE "ClassificationRecord" c SET "isPreferred" = true FROM ranked r
    WHERE c."classificationId" = r."classificationId" AND r.rn = 1
  `);

  // --- Refresh derived columns (best-effort; never abort the import) ---
  // These sweep the WHOLE table and can take minutes on a large DB. Set
  // HOLSTEIN_SKIP_RECOMPUTE=1 to skip them (e.g. for a quick incremental import),
  // then run `npm run classify:sires` / the rollback + pedigree scripts later.
  if (process.env.HOLSTEIN_SKIP_RECOMPUTE) {
    console.log("[holstein] HOLSTEIN_SKIP_RECOMPUTE set — skipping sire/rollback/pedigree recompute.");
  } else {
    try { const s = await classifySires(prisma); console.log(`[holstein] sires: ${s.proven} proven, ${s.genomic} genomic (latest ${s.latestRound})`); }
    catch (e) { console.warn(`[holstein] classifySires skipped: ${(e as Error).message}`); }
    try { const rb = await computeRollbackRatings(prisma); console.log(`[holstein] rollback: ${rb.rated} rated`); }
    catch (e) { console.warn(`[holstein] rollback skipped: ${(e as Error).message}`); }
    try { const pi = await computePedigreeIndexAll(prisma); console.log(`[holstein] pedigree index: ${pi.withIndex}/${pi.animals}`); }
    catch (e) { console.warn(`[holstein] pedigree index skipped: ${(e as Error).message}`); }
  }

  await prisma.auditLog.create({
    data: { entityType: "system", action: "import", notes: `Holstein.ca import: ${total} animals (${created} new), ${evals} evaluations, ${cls} classifications, ${errors} errors, ${skipped} skipped from ${files.length} file(s)` },
  });
  console.log(`\n[holstein] DONE — animals ${total} (${created} new) · evals ${evals} · classifications ${cls} · errors ${errors} · skipped ${skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
