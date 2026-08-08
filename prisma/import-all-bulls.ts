// ---------------------------------------------------------------------------
// Bulk import of EVERY bull in a Lactanet proof CSV — MULTI-ROUND aware.
//
// - New bull  -> create animal + identifiers + roles + this round's evaluation.
// - Existing bull (same reg from an earlier import) -> ADD this round's
//   evaluation (so proof-to-proof history builds up for rollback analysis).
// - Same round already imported for a bull -> skipped (idempotent / resumable).
// - isPreferred is kept on the LATEST-dated evaluation per bull.
//
// After the rows land it refreshes every DERIVED column (sire class, proof
// counts, rollback scores, pedigree index) — without that a new bull imports
// with proofRoundCount = 0 and is invisible to the Proof Change Report and the
// role filters, and existing bulls keep stale counts.
//
// Run it via `npm run import:all` — NOT bare `tsx`. This file reaches
// src/lib/lactanet.ts, which starts with `import "server-only"`; that package
// throws unless Node resolves it with the `react-server` condition, so the npm
// script passes `--conditions=react-server`. (Next.js aliases the package
// internally, which is why `next build` never surfaced this.)
//
// Streams the file; chunked createMany.
//
// Usage:  npx tsx prisma/import-all-bulls.ts [fileName] [limit]
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import readline from "readline";
import crypto from "crypto";
import { parseHeader, parseRow, type ParsedBull } from "../src/lib/lactanet";
import { packTraits } from "../src/lib/eval-traits";
import { classifyProofFile } from "../src/lib/proof-file-kind";
import { detectImportSystem, importSystemLabel } from "../src/lib/import-file-kind";
import { classifyRound, isGenotyped } from "../src/lib/sire-class";
import { classifySires } from "./classify-sires";
import { normalizePreferred } from "./normalize-preferred";
import { computeRollbackRatings } from "./compute-rollback";
import { computePedigreeIndexAll } from "./compute-pedigree-index";

const prisma = new PrismaClient();

const fileName = process.argv[2] || "aiobgepa2604_ho.csv";
const limit = process.argv[3] ? parseInt(process.argv[3]) : Infinity;
const importsDir = process.env.IMPORTS_DIR || "./imports";
const fullPath = path.join(importsDir, fileName);
const BATCH_BULLS = 2000;
const MAX_VARS = 18000;

function proofRun(gerun: string | null): { label: string; date: Date } {
  const m = (gerun ?? "").match(/^(\d{2})(\d{2})$/);
  if (!m) return { label: "April 2026", date: new Date(Date.UTC(2026, 3, 1)) };
  const yy = parseInt(m[1]);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  const month = Math.min(12, Math.max(1, parseInt(m[2])));
  const name = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month];
  return { label: `${name} ${year}`, date: new Date(Date.UTC(year, month - 1, 1)) };
}

async function insertChunked(model: { createMany: (a: { data: any[] }) => Promise<unknown> }, rows: any[], cols: number) {
  if (rows.length === 0) return;
  const chunk = Math.max(1, Math.floor(MAX_VARS / cols));
  for (let i = 0; i < rows.length; i += chunk) await model.createMany({ data: rows.slice(i, i + chunk) });
}

/** Read just the first line of a file without loading the rest of it. */
async function peekFirstLine(path: string): Promise<string | null> {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) { rl.close(); return line; }
  rl.close();
  return null;
}

async function main() {
  if (!fs.existsSync(fullPath)) { console.error(`[import-all] File not found: ${fullPath}`); process.exit(1); }

  // This importer speaks ONE format — the Lactanet bull-proof CSV. A CDCB file
  // handed to it would not error: parseRow would just read every column as
  // garbage (different delimiter, different field layout), which is worse than
  // refusing outright. Checked BEFORE any DB work, so a wrong file costs one
  // line read, not a wasted round of breed/source/animal lookups.
  const firstLine = await peekFirstLine(fullPath);
  const detectedSystem = detectImportSystem(fileName, firstLine);
  if (detectedSystem !== "lactanet") {
    const shown = firstLine ? `"${firstLine.slice(0, 70)}${firstLine.length > 70 ? "…" : ""}"` : "(empty file)";
    console.error(`[import-all] ${fileName} looks like ${importSystemLabel(detectedSystem)} file, not a Lactanet (Canadian) export — its first line reads ${shown}.`);
    if (detectedSystem === "cdcb") console.error(`[import-all] Use the CDCB importer instead: npx tsx --conditions=react-server prisma/import-cdcb.ts <folder-with-extracted-csvs>`);
    console.error(`[import-all] Refusing to import.`);
    process.exit(1);
  }

  // One file per run, so its kind is fixed for every row here. A stud proof file
  // resolves to "official"/"interim"; the whole-breed Holstein archive carries no
  // stud code and resolves to null, which is honest — it is not a Blondin
  // official-vs-interim round and must not be forced into one.
  const runKind = classifyProofFile(fileName).kind;
  console.log(`[import-all] importing ${fileName} (limit ${limit}) — run kind: ${runKind ?? "unknown"}`);

  // (The three SQLite PRAGMAs that used to live here — WAL / busy_timeout /
  //  synchronous — were left over from the SQLite era and threw a syntax error
  //  against PostgreSQL, which broke every run of this script after the
  //  Postgres migration. Postgres needs no equivalent session tuning here.)

  // Breed per bull, not per file: the Lactanet archives ship one file per breed
  // and the registration number carries the code (HO / JE / AY / BS / CN / GU /
  // MS). Stamping everything Holstein would misfile every non-Holstein archive,
  // and the true breed is NOT recoverable afterwards because the file is not
  // re-read. Same mapping src/lib/proof-import.ts and prisma/import-cdn.ts use.
  const breeds = new Map((await prisma.breed.findMany({ select: { breedCode: true, breedId: true } })).map((b) => [b.breedCode, b.breedId]));
  const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" } });
  const admin = await prisma.user.findFirst({ where: { role: "admin" } });

  // reg -> animalId for every existing registration/NAAB identifier.
  const regToAnimal = new Map<string, string>();
  for (const r of await prisma.animalIdentifier.findMany({
    where: { idType: { in: ["registration_ca", "registration_us", "registration_int"] } },
    select: { idValue: true, animalId: true },
  })) regToAnimal.set(r.idValue.toUpperCase(), r.animalId);

  // Which animals already carry a NAAB / marketing code. A bull that entered the
  // database before it was assigned a stud code would otherwise never pick one
  // up on a later round — and the Proof Change Report only covers NAAB bulls, so
  // it would stay invisible forever. Backfill it the first time a file has one.
  const hasNaab = new Set<string>();
  const hasMarketing = new Set<string>();
  for (const r of await prisma.animalIdentifier.findMany({
    where: { idType: { in: ["naab", "marketing_code"] } },
    select: { idType: true, animalId: true },
  })) (r.idType === "naab" ? hasNaab : hasMarketing).add(r.animalId);

  // existing evaluations: which (animalId|proofRun) already exist, and latest date per animal.
  const evalKey = new Set<string>();
  const maxDate = new Map<string, number>();
  for (const e of await prisma.geneticEvaluation.findMany({ select: { animalId: true, proofRun: true, evaluationDate: true, runKind: true } })) {
    evalKey.add(`${e.animalId}|${e.proofRun ?? ""}|${e.runKind ?? ""}`);
    const t = e.evaluationDate.getTime();
    if (!maxDate.has(e.animalId) || t > maxDate.get(e.animalId)!) maxDate.set(e.animalId, t);
  }
  console.log(`[import-all] existing: ${regToAnimal.size} bulls, ${evalKey.size} evaluations`);

  const capture = await prisma.sourceCapture.create({
    data: { sourceId: source?.sourceId, captureType: "report", originalFileName: fileName, capturedById: admin?.id, extractionStatus: "extracted", confidenceScore: 1, notes: `Bulk import of all bulls from ${fileName}` },
  });

  const buf = { animals: [] as any[], ids: [] as any[], roles: [] as any[], evals: [] as any[], peds: [] as any[] };
  const unprefer = new Set<string>(); // existing animals that received a newer round
  const nameUpdate = new Map<string, { name: string; short: string | null }>();
  let processed = 0, newBulls = 0, newEvals = 0, skipped = 0, inBatch = 0, newNaab = 0, noNaab = 0;

  async function flush() {
    if (buf.evals.length === 0 && buf.animals.length === 0) return;
    await insertChunked(prisma.animal, buf.animals, 10);
    await insertChunked(prisma.animalIdentifier, buf.ids, 7);
    await insertChunked(prisma.animalRole, buf.roles, 4);
    await insertChunked(prisma.geneticEvaluation, buf.evals, 42);
    await insertChunked(prisma.pedigreeReference, buf.peds, 6);
    buf.animals = []; buf.ids = []; buf.roles = []; buf.evals = []; buf.peds = [];
    inBatch = 0;
    process.stdout.write(`\r[import-all] processed ${processed} · new bulls ${newBulls} · new proofs ${newEvals} · skipped ${skipped}   `);
  }

  function queue(bull: ParsedBull) {
    const reg = bull.registrationNumber.toUpperCase();
    const { label, date } = proofRun(bull.proofRun);
    let animalId = regToAnimal.get(reg);
    const isNew = !animalId;

    if (isNew) {
      animalId = crypto.randomUUID();
      regToAnimal.set(reg, animalId);
      buf.animals.push({ id: animalId, primaryName: bull.registeredName, shortName: bull.shortName, sex: "M", breedId: breeds.get(bull.breedCode) ?? null, birthDate: bull.birthDate ? new Date(bull.birthDate + "T00:00:00Z") : null, countryOfOrigin: bull.country, currentStatus: "proven", createdById: admin?.id, notes: `Imported from ${fileName}.` });
      buf.ids.push({ animalId, idType: bull.regIdType, idValue: bull.registrationNumber, issuingCountry: bull.country, sourceId: source?.sourceId, isPrimary: true });
      if (bull.naabCode) buf.ids.push({ animalId, idType: "naab", idValue: bull.naabCode, sourceId: source?.sourceId, isPrimary: false });
      if (bull.naabMarketingCode) buf.ids.push({ animalId, idType: "marketing_code", idValue: bull.naabMarketingCode, sourceId: source?.sourceId, isPrimary: false });
      buf.roles.push({ animalId, roleType: "reference_sire", active: true });
      if (bull.naabCode) hasNaab.add(animalId);
      if (bull.naabMarketingCode) hasMarketing.add(animalId);
    } else {
      // Existing bull that has since been assigned a stud code — add it now.
      if (bull.naabCode && !hasNaab.has(animalId!)) {
        hasNaab.add(animalId!);
        buf.ids.push({ animalId, idType: "naab", idValue: bull.naabCode, sourceId: source?.sourceId, isPrimary: false });
        newNaab++;
      }
      if (bull.naabMarketingCode && !hasMarketing.has(animalId!)) {
        hasMarketing.add(animalId!);
        buf.ids.push({ animalId, idType: "marketing_code", idValue: bull.naabMarketingCode, sourceId: source?.sourceId, isPrimary: false });
      }
    }

    // Skip if this exact round already exists for this bull. The run kind is part
    // of the key: an official and an interim file share a GERUN, so keying on
    // (animal, label) alone would make the second file for a round a silent no-op.
    if (evalKey.has(`${animalId}|${label}|${runKind ?? ""}`)) { skipped++; return; }
    evalKey.add(`${animalId}|${label}|${runKind ?? ""}`);

    const priorMax = maxDate.get(animalId!) ?? -Infinity;
    const isPreferred = date.getTime() >= priorMax; // latest round is preferred
    if (isPreferred && !isNew) unprefer.add(animalId!); // older rounds must lose preferred
    if (date.getTime() > priorMax) maxDate.set(animalId!, date.getTime());
    // Names change over time — adopt the newest round's name (see import-cdn.ts).
    if (isPreferred && bull.registeredName) nameUpdate.set(animalId!, { name: bull.registeredName, short: bull.shortName });

    const evaluationId = crypto.randomUUID();
    const lpiRel = bull.traits.find((t) => t.traitCode === "LPI")?.reliability ?? null;
    const descriptive = ([["A2", bull.betaCasein], ["POLLED", bull.polled], ["COLOUR", bull.colourCode]] as const)
      .filter(([, v]) => v)
      .map(([code, v]) => ({ traitCode: code, numericValue: null, textValue: v as string, reliability: null, percentileRank: null }));
    const packed = packTraits([...bull.traits, ...descriptive]);
    buf.evals.push({ evaluationId, animalId, sourceId: source?.sourceId, captureId: capture.captureId, evaluationDate: date, proofRun: label, countrySystem: "CA", breedContext: bull.breedCode, reliabilityOverall: lpiRel != null ? lpiRel / 100 : null, isPreferred, approvalStatus: "approved", approvedById: admin?.id, approvedAt: date, createdById: admin?.id, runKind, sourceFile: fileName, activityCode: bull.activityCode, officialCode: bull.officialCode, genotyped: isGenotyped(bull.activityCode), daughters: bull.daughters, herds: bull.herds, sireType: classifyRound(bull), traitsJson: packed.traitsJson, ...packed.columns });
    if (isNew && bull.pedigree.length) {
      const summary = bull.pedigree.map((p) => `${p.relation.toUpperCase()}: ${p.name ?? "?"}${p.reg ? ` (${p.reg})` : ""}`).join(" · ");
      buf.peds.push({ animalId, sourceId: source?.sourceId, displayStatus: "linked", lastCheckedAt: date, notes: `Pedigree (from proof): ${summary}` });
    }
    if (isNew) newBulls++;
    newEvals++;
    inBatch++;
  }

  const rl = readline.createInterface({ input: fs.createReadStream(fullPath), crlfDelay: Infinity });
  let idx: Map<string, number> | null = null;
  for await (const line of rl) {
    if (!idx) { idx = parseHeader(line); continue; }
    if (processed >= limit) break;
    const bull = parseRow(line.split(","), idx);
    processed++;
    if (!bull) { skipped++; continue; }
    // Bulk-import policy, applied HERE and nowhere else: an archive row without a
    // NAAB code is an international/unmarketed sire that inflates the table
    // without ever appearing in the semen catalogue. The parser deliberately does
    // not drop these — the interactive /import-proofs path must keep updating an
    // existing bull whose row happens to have a blank stud code.
    if (!bull.naabCode) { noNaab++; continue; }
    queue(bull);
    if (inBatch >= BATCH_BULLS) await flush();
  }
  rl.close();
  await flush();

  // Adopt each bull's name from its newest round in this file (see import-cdn.ts).
  if (nameUpdate.size) {
    const rows = [...nameUpdate.entries()].map(([id, v]) => ({ id, name: v.name, short: v.short }));
    for (let i = 0; i < rows.length; i += 1000) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Animal" a SET "primaryName" = v.name, "shortName" = v.short
           FROM jsonb_to_recordset($1::jsonb) AS v(id text, name text, short text)
          WHERE a."id" = v.id`,
        JSON.stringify(rows.slice(i, i + 1000)),
      );
    }
    console.log(`[import-all] refreshed ${rows.length} bull names to their newest round`);
  }

  // Enforce the invariant: exactly ONE preferred eval per bull (latest approved
  // round, official outranking interim on a shared date). Shared with
  // prisma/import-cdn.ts and runnable standalone — see prisma/normalize-preferred.ts
  // for why it is change-only and chunked (it is the step that burst pg_wal).
  void unprefer;
  const pref = await normalizePreferred(prisma, { log: (m) => console.log(m) });
  console.log(`\n[import-all] preferred flag: ${pref.flipped} changed, ${pref.preferred} preferred evaluations set`);

  // ---------------------------------------------------------------------
  // Refresh every derived column the app filters and reports on. Without
  // this a newly imported bull lands with proofRoundCount = 0 and no
  // sireType, so it is INVISIBLE to the Proof Change Report (which requires
  // >= 2 rounds), to the proven/genomic/active/inactive filters, and to
  // Proof Trends — and existing bulls keep last month's stale counts.
  // Chaining it here means every import path gets it for free, including
  // the "start bulk import" button (which shells out to `npm run import:all`).
  // ---------------------------------------------------------------------
  console.log(`[import-all] refreshing derived columns…`);
  const cls = await classifySires(prisma);
  console.log(`[import-all]   sire classes — latest round ${cls.latestRound ?? "?"}: ${cls.active} active, ${cls.inactive} inactive, ${cls.proven} proven, ${cls.genomic} genomic`);
  const rb = await computeRollbackRatings(prisma);
  console.log(`[import-all]   rollback — ${rb.scored} scored, ${rb.rated} rated (base ${Math.round(rb.mean * 10) / 10}, SD ${Math.round(rb.sd * 100) / 100})`);
  const pi = await computePedigreeIndexAll(prisma);
  console.log(`[import-all]   pedigree index — ${pi.withIndex}/${pi.animals} animals (${pi.highConfidence} high confidence)`);

  await prisma.auditLog.create({ data: { entityType: "system", action: "import", notes: `Bulk import ${fileName}: ${newBulls} new bulls, ${newEvals} new proofs, ${skipped} skipped; refreshed ${cls.active + cls.inactive} sire classifications, ${rb.scored} rollback scores` } });
  console.log(`\n[import-all] DONE — new bulls ${newBulls}, new proofs ${newEvals}, NAAB codes backfilled ${newNaab}, skipped ${skipped}, no NAAB code (dropped) ${noNaab}, processed ${processed}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
