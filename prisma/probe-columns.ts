// Diagnostic: for every proof era, report which of the columns the Lactanet
// parser actually references are MISSING from that era's header, and offer the
// closest candidates from that era so a human can confirm the rename.
//
//   npx tsx --conditions=react-server prisma/probe-columns.ts <hdr_2020.txt> ...
//
// Deliberately does NOT guess: it only reports, so a wrong rename can never be
// applied silently. Not part of the app.

import fs from "fs";

// Every column name referenced by src/lib/lactanet.ts, grouped so the report
// says which part of the proof would be lost.
const REFERENCED: Record<string, string[]> = {
  identity: [
    "REGISTRATION NUMBER", "REGISTERED NAME", "SHORT NAME", "BIRTH DATE",
    "NAAB CODE", "NAAB MARKETING CODE", "POLLED", "BETA CASEIN (A2)", "COLOUR CODE",
    "GERUN", "PROOF ACTIVITY CODE and GENOTYPE INDICATOR", "LPI OFFICIAL CODE",
    "NUMBER OF DAUGHTERS 120/90 DIM (HO/CB)", "DAUGHTERS PROTEIN", "HERDS PROTEIN",
    "RELIABILITY PROTEIN",
  ],
  indexes: [
    "LPI", "LPI RELIABILITY", "LPI PERCENTILE RANK", "PRO$",
    "PRODUCTION INDEX (PI)", "PI RELIABILITY", "PI PERCENTILE RANK",
    "LONGEVITY & TYPE INDEX (LTI)", "LTI RELIABILITY", "LTI PERCENTILE RANK",
    "HEALTH & WELFARE INDEX (HWI)", "HWI RELIABILITY", "HWI PERCENTILE RANK",
    "REPRODUCTION INDEX (RI)", "RI RELIABILITY", "RI PERCENTILE RANK",
    "MILKABILITY INDEX (MI)", "MI RELIABILITY", "MI PERCENTILE RANK",
    "ENVIRONMENTAL IMPACT INDEX (EI)", "EI RELIABILITY", "EI PERCENTILE RANK",
  ],
  production: [
    "EBV MILK KG", "PERCENTILE RANK MILK", "EBV FAT KG", "PERCENTILE RANK FAT",
    "EBV PROTEIN KG", "PERCENTILE RANK PROTEIN", "EBV FAT PERCENT", "EBV PROTEIN PERCENT",
  ],
  conformation: [
    "EBV CONFORMATION", "PERCENTILE RANK CONFORMATION", "AVERAGE FINAL SCORE",
    "MAMMARY SYSTEM", "PERCENTILE RANK MAMMARY SYSTEM",
    "FEET & LEGS", "PERCENTILE RANK FEET & LEGS",
    "DAIRY STRENGTH", "PERCENTILE RANK DAIRY STRENGTH",
    "RUMP", "PERCENTILE RANK RUMP",
  ],
  linear: [
    "STATURE", "HEIGHT AT FRONT END", "CHEST WIDTH", "BODY DEPTH", "RIB STRUCTURE",
    "RUMP ANGLE", "PIN WIDTH", "LOIN STRENGTH", "THURL PLACEMENT", "FOOT ANGLE",
    "HEEL DEPTH", "BONE QUALITY", "REAR LEGS SIDE VIEW", "REAR LEGS REAR VIEW",
    "FRONT LEGS VIEW", "LOCOMOTION", "FORE ATTACHMENT", "REAR ATTACHMENT HEIGHT",
    "REAR ATTACHMENT WIDTH", "UDDER DEPTH", "UDDER TEXTURE", "MEDIAN SUSPENSORY",
    "FORE TEAT PLACEMENT", "REAR TEAT PLACEMENT", "TEAT LENGTH",
  ],
  pedigree: [
    "SIRE REGISTRATION NUMBER", "SIRE NAME", "DAM REGISTRATION NUMBER", "DAM NAME",
    "MGS REGISTRATION NUMBER", "MGS NAME", "MGD REGISTRATION NUMBER", "MGD NAME",
    "GMGS REGISTRATION NUMBER", "GMGS NAME", "GMGD REGISTRATION NUMBER", "GMGD NAME",
  ],
};

/** Token-overlap similarity, for suggesting what a missing column was renamed to. */
function similar(want: string, have: string[]): string[] {
  const toks = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2));
  const w = toks(want);
  if (!w.size) return [];
  return have
    .map((h) => {
      const t = toks(h);
      let hit = 0;
      for (const x of w) if (t.has(x)) hit++;
      return { h, score: hit / Math.max(w.size, 1) };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.h);
}

for (const file of process.argv.slice(2)) {
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/)[0];
  const cols = raw.split(",").map((c) => c.trim());
  const have = new Set(cols);
  const era = (file.match(/(\d{4})/) ?? [])[1] ?? file;

  console.log("\n" + "=".repeat(74));
  console.log(`ERA ${era}  —  ${cols.length} columns`);
  console.log("=".repeat(74));

  let totalMissing = 0;
  for (const [group, names] of Object.entries(REFERENCED)) {
    const missing = names.filter((n) => !have.has(n));
    totalMissing += missing.length;
    if (!missing.length) {
      console.log(`  ${group.padEnd(13)} OK (${names.length}/${names.length})`);
      continue;
    }
    console.log(`  ${group.padEnd(13)} ${names.length - missing.length}/${names.length} — MISSING ${missing.length}:`);
    for (const m of missing) {
      const cand = similar(m, cols);
      console.log(`      "${m}"`);
      if (cand.length) console.log(`         candidates: ${cand.map((c) => `"${c}"`).join(", ")}`);
      else console.log(`         (no similar column — trait genuinely absent this era)`);
    }
  }
  console.log(`  TOTAL MISSING: ${totalMissing}`);
}
console.log("");
