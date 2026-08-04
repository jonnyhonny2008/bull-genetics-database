// ---------------------------------------------------------------------------
// Import all Blondin CDN proof CSVs (staged in imports/cdn) — MULTI-ROUND,
// MULTI-BREED, format-tolerant (handles 230-col older + 274-col newer via
// header-name mapping). Each (registration, run) becomes one dated proof round,
// so every bull's performance-over-time (rollback resistance) is populated.
//
// Usage:  npx tsx prisma/import-cdn.ts [stageDir]
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import readline from "readline";
import crypto from "crypto";
import { parseHeader, parseRow, type ParsedBull } from "../src/lib/lactanet";
import { packTraits } from "../src/lib/eval-traits";
import { classifyProofFile, type ProofRunKind } from "../src/lib/proof-file-kind";
import { classifyRound, isGenotyped } from "../src/lib/sire-class";
import { classifySires } from "./classify-sires";
import { computeRollbackRatings } from "./compute-rollback";
import { computePedigreeIndexAll } from "./compute-pedigree-index";

const prisma = new PrismaClient();
const stageDir = process.argv[2] || path.join(process.env.IMPORTS_DIR || "./imports", "cdn");
const MAX_VARS = 18000;

function proofRun(gerun: string | null): { label: string; date: Date } {
  const m = (gerun ?? "").match(/^(\d{2})(\d{2})$/);
  if (!m) return { label: "Unknown run", date: new Date(Date.UTC(2000, 0, 1)) };
  const yy = parseInt(m[1]); const year = yy > 50 ? 1900 + yy : 2000 + yy;
  const month = Math.min(12, Math.max(1, parseInt(m[2])));
  const name = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month];
  return { label: `${name} ${year}`, date: new Date(Date.UTC(year, month - 1, 1)) };
}
function breedFromName(fn: string): string {
  const l = fn.toLowerCase();
  if (l.includes("_je")) return "JE";
  if (l.includes("_ay")) return "AY";
  if (l.includes("_bs")) return "BS";
  return "HO";
}
function sexFromReg(reg: string): string { const m = reg.toUpperCase().match(/([MF])\d{4,}/); return m ? m[1] : "M"; }

async function insertChunked(model: { createMany: (a: { data: any[] }) => Promise<unknown> }, rows: any[], cols: number) {
  if (!rows.length) return;
  const chunk = Math.max(1, Math.floor(MAX_VARS / cols));
  for (let i = 0; i < rows.length; i += chunk) await model.createMany({ data: rows.slice(i, i + chunk) });
}

async function main() {
  if (!fs.existsSync(stageDir)) { console.error(`[cdn] staging dir not found: ${stageDir}`); process.exit(1); }
  const files = fs.readdirSync(stageDir).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(stageDir, f));
  console.log(`[cdn] ${files.length} CSV files to import from ${stageDir}`);

  const breeds = new Map((await prisma.breed.findMany()).map((b) => [b.breedCode, b.breedId]));
  const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" } });
  const admin = await prisma.user.findFirst({ where: { role: "admin" } });

  const regToAnimal = new Map<string, string>();
  for (const r of await prisma.animalIdentifier.findMany({ where: { idType: { in: ["registration_ca", "registration_us", "registration_int"] } }, select: { idValue: true, animalId: true } }))
    regToAnimal.set(r.idValue.toUpperCase(), r.animalId);
  const evalKey = new Set<string>();
  const maxDate = new Map<string, number>();
  for (const e of await prisma.geneticEvaluation.findMany({ select: { animalId: true, proofRun: true, evaluationDate: true, runKind: true } })) {
    // Seed key MUST match the in-run key exactly (animal|label|kind), or a
    // re-import of an already-loaded file would fail to recognise its own rows
    // and duplicate every one of them.
    evalKey.add(`${e.animalId}|${e.proofRun ?? ""}|${e.runKind ?? ""}`);
    const t = e.evaluationDate.getTime();
    if (!maxDate.has(e.animalId) || t > maxDate.get(e.animalId)!) maxDate.set(e.animalId, t);
  }
  console.log(`[cdn] existing: ${regToAnimal.size} animals, ${evalKey.size} evaluations`);

  const capture = await prisma.sourceCapture.create({ data: { sourceId: source?.sourceId, captureType: "report", originalFileName: "CDN batch", capturedById: admin?.id, extractionStatus: "extracted", confidenceScore: 1, notes: "Blondin CDN multi-round import" } });

  const buf = { animals: [] as any[], ids: [] as any[], roles: [] as any[], evals: [] as any[], peds: [] as any[] };
  const unprefer = new Set<string>();
  let newAnimals = 0, newEvals = 0, skipped = 0, rowsSeen = 0;

  async function flush() {
    if (!buf.evals.length && !buf.animals.length) return;
    await insertChunked(prisma.animal, buf.animals, 10);
    await insertChunked(prisma.animalIdentifier, buf.ids, 7);
    await insertChunked(prisma.animalRole, buf.roles, 4);
    await insertChunked(prisma.geneticEvaluation, buf.evals, 42);
    await insertChunked(prisma.pedigreeReference, buf.peds, 6);
    buf.animals = []; buf.ids = []; buf.roles = []; buf.evals = []; buf.peds = [];
  }

  function queue(bull: ParsedBull, breedCode: string, runKind: ProofRunKind, fileName: string) {
    const reg = bull.registrationNumber.toUpperCase();
    const { label, date } = proofRun(bull.proofRun);
    if (label === "Unknown run") { skipped++; return; }
    let animalId = regToAnimal.get(reg);
    const isNew = !animalId;
    if (isNew) {
      animalId = crypto.randomUUID();
      regToAnimal.set(reg, animalId);
      buf.animals.push({ id: animalId, primaryName: bull.registeredName, shortName: bull.shortName, sex: sexFromReg(reg), breedId: breeds.get(breedCode) ?? breeds.get("HO") ?? null, birthDate: bull.birthDate ? new Date(bull.birthDate + "T00:00:00Z") : null, countryOfOrigin: bull.country, currentStatus: "proven", createdById: admin?.id, notes: "Imported from Blondin CDN proof files." });
      buf.ids.push({ animalId, idType: bull.regIdType, idValue: bull.registrationNumber, issuingCountry: bull.country, sourceId: source?.sourceId, isPrimary: true });
      if (bull.naabCode) buf.ids.push({ animalId, idType: "naab", idValue: bull.naabCode, sourceId: source?.sourceId, isPrimary: false });
      if (bull.naabMarketingCode) buf.ids.push({ animalId, idType: "marketing_code", idValue: bull.naabMarketingCode, sourceId: source?.sourceId, isPrimary: false });
      buf.roles.push({ animalId, roleType: sexFromReg(reg) === "F" ? "cow" : "reference_sire", active: true });
    }
    // The run kind belongs in the key. Official and interim files stamp the same
    // GERUN, so keying on (animal, label) alone made the second file for a round
    // a silent no-op — whichever sorted first won, and 587 of 591 checked rows
    // ended up holding the interim value with nothing recording that.
    if (evalKey.has(`${animalId}|${label}|${runKind}`)) { skipped++; return; }
    evalKey.add(`${animalId}|${label}|${runKind}`);
    const priorMax = maxDate.get(animalId!) ?? -Infinity;
    const isPreferred = date.getTime() >= priorMax;
    if (isPreferred && !isNew) unprefer.add(animalId!);
    if (date.getTime() > priorMax) maxDate.set(animalId!, date.getTime());

    const lpiRel = bull.traits.find((t) => t.traitCode === "LPI")?.reliability ?? null;
    const descriptive = ([["A2", bull.betaCasein], ["POLLED", bull.polled], ["COLOUR", bull.colourCode]] as const)
      .filter(([, v]) => v).map(([code, v]) => ({ traitCode: code, numericValue: null, textValue: v as string, reliability: null, percentileRank: null }));
    const packed = packTraits([...bull.traits, ...descriptive]);
    buf.evals.push({
      evaluationId: crypto.randomUUID(), animalId, sourceId: source?.sourceId, captureId: capture.captureId,
      evaluationDate: date, proofRun: label, countrySystem: "CA", breedContext: breedCode,
      reliabilityOverall: lpiRel != null ? lpiRel / 100 : null, isPreferred, approvalStatus: "approved",
      approvedById: admin?.id, approvedAt: date, createdById: admin?.id,
      runKind, sourceFile: fileName,
      // Lactanet status codes for this round (decoded in src/lib/sire-class.ts).
      activityCode: bull.activityCode, officialCode: bull.officialCode,
      genotyped: isGenotyped(bull.activityCode), daughters: bull.daughters, herds: bull.herds,
      sireType: classifyRound(bull),
      traitsJson: packed.traitsJson, ...packed.columns,
    });
    if (isNew && bull.pedigree.length) {
      const summary = bull.pedigree.map((p) => `${p.relation.toUpperCase()}: ${p.name ?? "?"}${p.reg ? ` (${p.reg})` : ""}`).join(" · ");
      buf.peds.push({ animalId, sourceId: source?.sourceId, displayStatus: "linked", lastCheckedAt: date, notes: `Pedigree (from proof): ${summary}` });
    }
    if (isNew) newAnimals++;
    newEvals++;
  }

  let fileNo = 0, skippedFiles = 0;
  const byKind: Record<string, number> = {};
  for (const file of files) {
    fileNo++;
    const id = classifyProofFile(file);
    // Only bull proof rounds become evaluations. A "pregeno" file is the
    // evaluation computed WITHOUT genomics — every LPI in it differs from both
    // the official and the interim file for the same GERUN — so importing one as
    // a round would silently replace real proofs with parallel-universe numbers.
    // Cow and private-stud extracts are likewise not this stud's bull rounds.
    if (!id.kind) {
      skippedFiles++;
      console.log(`[cdn] skip ${id.family.padEnd(11)} ${path.basename(file)}`);
      continue;
    }
    byKind[id.kind] = (byKind[id.kind] ?? 0) + 1;
    // Prefer the breed parsed off the name by the classifier; fall back to the
    // older substring sniff so an unrecognised suffix still imports as Holstein.
    const breedCode = id.breed ?? breedFromName(path.basename(file));
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let idx: Map<string, number> | null = null;
    for await (const line of rl) {
      if (!idx) { idx = parseHeader(line); continue; }
      const bull = parseRow(line.split(","), idx);
      rowsSeen++;
      if (!bull) { skipped++; continue; }
      queue(bull, breedCode, id.kind, path.basename(file));
    }
    rl.close();
    if (fileNo % 25 === 0) { await flush(); process.stdout.write(`\r[cdn] files ${fileNo}/${files.length} · animals ${newAnimals} · proofs ${newEvals} · skipped ${skipped}   `); }
  }
  await flush();

  // Enforce the invariant: exactly ONE preferred eval per animal (latest approved
  // proof). A single window-function pass is correct regardless of file order and
  // covers both this run's rows and any pre-existing ones. (`unprefer` set kept for
  // clarity but superseded by this authoritative recompute.)
  void unprefer;
  await prisma.$executeRawUnsafe(`UPDATE "GeneticEvaluation" SET "isPreferred" = false WHERE "isPreferred" = true`);
  // An OFFICIAL round outranks an INTERIM one of the same date. Both kinds carry
  // the same evaluationDate, so without this tiebreak the winner came down to
  // "lpi DESC" — i.e. whichever file happened to flatter the bull.
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT "evaluationId",
             ROW_NUMBER() OVER (PARTITION BY "animalId"
               ORDER BY "evaluationDate" DESC,
                        CASE "runKind" WHEN 'official' THEN 0 WHEN 'interim' THEN 1 ELSE 2 END,
                        "lpi" DESC NULLS LAST, "evaluationId" DESC) AS rn
      FROM "GeneticEvaluation" WHERE "approvalStatus" = 'approved'
    )
    UPDATE "GeneticEvaluation" g SET "isPreferred" = true
    FROM ranked r WHERE g."evaluationId" = r."evaluationId" AND r.rn = 1
  `);
  // Re-derive proven/genomic, active/inactive and the April rollback tally for
  // every sire now that this round's proofs are in.
  await classifySires(prisma);
  // Re-score round-to-round retention and re-base the 100-point rating against
  // the (possibly changed) active lineup.
  const rb = await computeRollbackRatings(prisma);
  console.log(`[cdn] rollback ratings: ${rb.rated} bulls · baseline n=${rb.baselineN} mean=${rb.mean}% sd=${rb.sd}`);
  // Re-estimate the pedigree index now that new ancestors may be resolvable.
  const pi = await computePedigreeIndexAll(prisma);
  console.log(`[cdn] pedigree index: ${pi.withIndex}/${pi.animals} animals got an index (${pi.highConfidence} at ≥85% confidence)`);

  await prisma.auditLog.create({ data: { entityType: "system", action: "import", notes: `CDN import: ${newAnimals} animals, ${newEvals} proof rounds from ${files.length} files` } });
  const kinds = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  console.log(`\n[cdn] DONE — files ${files.length} (imported by kind: ${kinds}; ${skippedFiles} non-round files skipped), rows ${rowsSeen}, new animals ${newAnimals}, new proof rounds ${newEvals}, skipped rows ${skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
