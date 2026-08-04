// Diagnostic: run the REAL Lactanet parser against one sample row from each
// proof era and report what it actually extracts. Verifies whether the
// name-keyed parser tolerates the changing column counts (230 → 243 → 250 → 274)
// without silently mapping the wrong column to a trait.
//
//   npx tsx prisma/probe-eras.ts <file1.csv> <file2.csv> ...
//
// Not part of the app; a throwaway measurement tool.

import fs from "fs";
import readline from "readline";
import { parseHeader, parseRow } from "../src/lib/lactanet";

// The fields that must resolve for an import to be trustworthy.
const CRITICAL = [
  "REGISTRATION NUMBER", "REGISTERED NAME", "BIRTH DATE", "NAAB CODE", "GERUN",
  "LPI", "PRO$", "EBV MILK KG", "EBV FAT KG", "EBV PROTEIN KG",
  "EBV CONFORMATION", "MAMMARY SYSTEM", "FEET & LEGS",
  "SIRE REGISTRATION NUMBER", "DAM REGISTRATION NUMBER",
];

async function firstRows(file: string, n: number): Promise<{ header: string; rows: string[] }> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = "";
  const rows: string[] = [];
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    if (line.trim()) rows.push(line);
    if (rows.length >= n) break;
  }
  rl.close();
  return { header, rows };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: tsx prisma/probe-eras.ts <csv...>"); process.exit(1); }

  for (const f of files) {
    const label = f.split(/[\\/]/).pop();
    console.log("\n" + "=".repeat(72));
    console.log(label);
    console.log("=".repeat(72));

    const { header, rows } = await firstRows(f, 400);
    const idx = parseHeader(header);
    console.log(`  columns in header: ${header.split(",").length}`);

    const missing = CRITICAL.filter((c) => !idx.has(c));
    console.log(`  critical columns resolved: ${CRITICAL.length - missing.length}/${CRITICAL.length}`);
    if (missing.length) console.log(`  MISSING: ${missing.join(", ")}`);

    // Parse the sample and report yield.
    let parsed = 0, skippedNoNaab = 0, traitTotal = 0;
    let sample: ReturnType<typeof parseRow> = null;
    for (const line of rows) {
      const b = parseRow(line.split(","), idx);
      if (!b) { skippedNoNaab++; continue; }
      parsed++;
      traitTotal += b.traits.length;
      if (!sample) sample = b;
    }
    console.log(`  sample rows: ${rows.length} → parsed ${parsed}, skipped(no NAAB) ${skippedNoNaab}`);
    console.log(`  avg traits per parsed bull: ${parsed ? (traitTotal / parsed).toFixed(1) : 0}`);

    if (sample) {
      console.log(`  EXAMPLE: ${sample.registeredName} (${sample.registrationNumber})`);
      // Breed is deliberately read off the registration prefix rather than a
      // parser field: this diagnostic must compile against whatever shape
      // ParsedBull currently has, and it long outlived the field it used to log.
      const breed = sample.registrationNumber.slice(0, 2).toUpperCase();
      console.log(`     naab=${sample.naabCode} breed=${breed} born=${sample.birthDate} run=${sample.proofRun}`);
      const show = ["LPI", "PRO$", "MILK", "FAT", "PROT", "CONF", "MAMM", "FL"];
      const vals = show
        .map((c) => { const t = sample!.traits.find((x) => x.traitCode === c); return t ? `${c}=${t.numericValue}` : `${c}=–`; })
        .join("  ");
      console.log(`     ${vals}`);
      console.log(`     pedigree: ${sample.pedigree.map((p) => `${p.relation}:${p.name ?? "?"}`).join(", ") || "(none)"}`);
    }
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
