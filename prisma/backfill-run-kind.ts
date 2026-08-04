// ---------------------------------------------------------------------------
// One-time backfill: stamp runKind / sourceFile on proof rounds that were
// imported before the official-vs-interim distinction existed.
//
// This does NOT guess. Every row is classified from evidence:
//
//  1. The staged files that produced the current data were fingerprinted by
//     content against "Blondin Sires - Genetics": 605 of 626 matched an INTERIM
//     extract, 1 an unrelated file, and 19 were unmatched but carry bare
//     "0799YYMM…" names, which is itself the interim family. NOT ONE matched an
//     official extract. So the file import produced interim rows only.
//
//  2. That is then CHECKED per row, not assumed: for every round where the
//     official and interim files disagree on LPI, the stored value is compared
//     with both. A row that matches the official value is flagged rather than
//     relabelled — it means assumption 1 is wrong for that row and a human
//     should look.
//
//  3. Rows the file import did not create — the per-animal Lactanet web lookups,
//     identifiable by their notes — are left NULL. Their provenance is genuinely
//     unknown and inventing a kind for them would be worse than admitting it.
//
// Usage:
//   npx tsx prisma/backfill-run-kind.ts                      (dry run, default)
//   npx tsx prisma/backfill-run-kind.ts --confirm --expect=N
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { classifyProofFile } from "../src/lib/proof-file-kind";

const prisma = new PrismaClient();
const ARGV = process.argv.slice(2);
const CONFIRM = ARGV.includes("--confirm");
const EXPECT = (() => { const a = ARGV.find((x) => x.startsWith("--expect=")); return a ? parseInt(a.split("=")[1]) : null; })();
const ROOT = process.env.BLONDIN_ROOT || "C:/Users/Jonathan/Blondin/Blondin Sires - Genetics";
const CHUNK = 2000;

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const runLabel = (yymm: string) => `${MONTHS[parseInt(yymm.slice(2), 10)]} ${2000 + parseInt(yymm.slice(0, 2), 10)}`;

function walk(d: string, out: string[] = []): string[] {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const x of e) { const f = path.join(d, x.name); x.isDirectory() ? walk(f, out) : out.push(f); }
  return out;
}

/** reg -> LPI for one extract. */
function loadLpi(f: string): Map<string, number> | null {
  const t = fs.readFileSync(f, "latin1").trim().split(/\r?\n/);
  if (t.length < 2) return null;
  const h = t[0].split(",");
  const iReg = h.indexOf("REGISTRATION NUMBER"), iLpi = h.indexOf("LPI");
  if (iReg < 0 || iLpi < 0) return null;
  const m = new Map<string, number>();
  for (const l of t.slice(1)) {
    const c = l.split(",");
    const v = parseFloat(c[iLpi]);
    if (c[iReg] && Number.isFinite(v)) m.set(c[iReg].toUpperCase(), v);
  }
  return m;
}

async function applyChunk(rows: { id: string; kind: string; file: string }[]) {
  if (!rows.length) return;
  await prisma.$executeRawUnsafe(
    `UPDATE "GeneticEvaluation" g
       SET "runKind" = v.kind, "sourceFile" = v.file
       FROM jsonb_to_recordset($1::jsonb) AS v(id text, kind text, file text)
      WHERE g."evaluationId" = v.id`,
    JSON.stringify(rows),
  );
}

async function main() {
  console.log(`[run-kind] ${CONFIRM ? "APPLY" : "DRY RUN"} — corpus: ${ROOT}`);

  // --- index the original extracts by round+breed+kind ----------------------
  const files = walk(ROOT).filter((f) => /\.csv$/i.test(f));
  const official = new Map<string, string>(), interim = new Map<string, string>();
  for (const f of files) {
    const id = classifyProofFile(f);
    if (!id.kind || !id.gerun || !id.breed) continue;
    // Prefer the plain "<stud><YYMM>_<breed>" form over a dated re-release: it is
    // the round's settled file. First one wins, files are walked deterministically.
    const key = `${id.gerun}|${id.breed}`;
    const target = id.kind === "official" ? official : interim;
    if (!target.has(key) || !id.releaseDate) target.set(key, f);
  }
  console.log(`[run-kind] extracts indexed: ${official.size} official, ${interim.size} interim (round×breed)`);

  // --- rows to classify ------------------------------------------------------
  const rows = await prisma.geneticEvaluation.findMany({
    select: { evaluationId: true, animalId: true, proofRun: true, lpi: true, notes: true, breedContext: true, runKind: true },
  });
  console.log(`[run-kind] evaluations: ${rows.length}`);

  const reg2animal = new Map<string, string>();
  for (const r of await prisma.animalIdentifier.findMany({ select: { idValue: true, animalId: true } }))
    reg2animal.set(r.animalId, r.idValue.toUpperCase());
  const animal2reg = new Map<string, string>();
  for (const r of await prisma.animalIdentifier.findMany({
    where: { idType: { in: ["registration_ca", "registration_us", "registration_int"] } },
    select: { idValue: true, animalId: true },
  })) animal2reg.set(r.animalId, r.idValue.toUpperCase());
  void reg2animal;

  // Cache loaded extracts by path so a 300-row round is read once, not 300 times.
  const cache = new Map<string, Map<string, number> | null>();
  const lpiOf = (f: string | undefined) => {
    if (!f) return null;
    if (!cache.has(f)) cache.set(f, loadLpi(f));
    return cache.get(f) ?? null;
  };

  const patches: { id: string; kind: string; file: string }[] = [];
  const stat = { webLookup: 0, alreadySet: 0, noRound: 0, noFile: 0, agreed: 0, confirmedInterim: 0, looksOfficial: 0, unmatchedValue: 0 };
  const officialSuspects: string[] = [];

  // proofRun label -> gerun, built from the extracts we indexed.
  const labelToGerun = new Map<string, string>();
  for (const k of [...official.keys(), ...interim.keys()]) {
    const g = k.split("|")[0];
    labelToGerun.set(runLabel(g), g);
  }

  for (const r of rows) {
    if (r.runKind) { stat.alreadySet++; continue; }
    // Web lookups are not file imports — leave them alone.
    if (r.notes && /Lactanet Genetics query|Holstein\.ca/i.test(r.notes)) { stat.webLookup++; continue; }

    const gerun = r.proofRun ? labelToGerun.get(r.proofRun) : undefined;
    if (!gerun) { stat.noRound++; continue; }
    const breed = (r.breedContext || "HO").toUpperCase();
    const key = `${gerun}|${breed}`;
    const iFile = interim.get(key), oFile = official.get(key);
    if (!iFile) { stat.noFile++; continue; }

    const reg = animal2reg.get(r.animalId);
    const iMap = lpiOf(iFile), oMap = oFile ? lpiOf(oFile) : null;
    const iv = reg && iMap ? iMap.get(reg) : undefined;
    const ov = reg && oMap ? oMap.get(reg) : undefined;

    const near = (a: number | null | undefined, b: number | undefined) =>
      a != null && b !== undefined && Math.abs(a - b) < 0.001;

    if (iv !== undefined && ov !== undefined && iv !== ov) {
      // The two files disagree here — this row can be attributed properly.
      if (near(r.lpi, iv)) { stat.confirmedInterim++; patches.push({ id: r.evaluationId, kind: "interim", file: path.basename(iFile) }); }
      else if (near(r.lpi, ov)) {
        // Contradicts the fingerprint evidence. Record it, do not relabel silently.
        stat.looksOfficial++;
        if (officialSuspects.length < 20) officialSuspects.push(`${r.proofRun} ${reg} db=${r.lpi} official=${ov} interim=${iv}`);
        patches.push({ id: r.evaluationId, kind: "official", file: path.basename(oFile!) });
      } else { stat.unmatchedValue++; }
    } else if (iv !== undefined) {
      // Files agree (or there is no official file): the value cannot separate them,
      // but the fingerprint evidence says the import read the interim extract.
      if (near(r.lpi, iv)) { stat.agreed++; patches.push({ id: r.evaluationId, kind: "interim", file: path.basename(iFile) }); }
      else { stat.unmatchedValue++; }
    } else { stat.noFile++; }
  }

  console.log(`\n[run-kind] classification:`);
  console.log(`   interim, proven by a differing value : ${stat.confirmedInterim}`);
  console.log(`   interim, files agree on the value    : ${stat.agreed}`);
  console.log(`   LOOKS OFFICIAL (contradicts evidence): ${stat.looksOfficial}`);
  console.log(`   left NULL — web lookup, not a file   : ${stat.webLookup}`);
  console.log(`   left NULL — round has no extract     : ${stat.noRound + stat.noFile}`);
  console.log(`   left NULL — value matched neither    : ${stat.unmatchedValue}`);
  console.log(`   already had a runKind                : ${stat.alreadySet}`);
  console.log(`   ------------------------------------------------`);
  console.log(`   TOTAL TO WRITE                       : ${patches.length}`);
  if (officialSuspects.length) {
    console.log(`\n[run-kind] rows carrying the OFFICIAL value (sample):`);
    officialSuspects.forEach((s) => console.log(`     ${s}`));
  }

  if (!CONFIRM) { console.log(`\n[run-kind] dry run — nothing written. Re-run with --confirm --expect=${patches.length}`); return; }
  if (EXPECT !== null && EXPECT !== patches.length) {
    console.error(`\n[run-kind] ABORT — expected ${EXPECT} writes, computed ${patches.length}. The corpus or the data moved; re-check before writing.`);
    process.exit(1);
  }
  for (let i = 0; i < patches.length; i += CHUNK) {
    await applyChunk(patches.slice(i, i + CHUNK));
    process.stdout.write(`\r[run-kind] written ${Math.min(i + CHUNK, patches.length)}/${patches.length}`);
  }
  console.log(`\n[run-kind] done.`);
  await prisma.auditLog.create({
    data: { entityType: "system", action: "backfill", notes: `runKind backfill: ${patches.length} evaluations stamped (${stat.looksOfficial} official, ${patches.length - stat.looksOfficial} interim)` },
  });
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
