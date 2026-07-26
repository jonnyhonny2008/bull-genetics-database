// Establish, from the real CDN files, how to tell a daughter-proven sire (has EBVs)
// from a GPA-only genomic sire. Cross-tabulates the self-documenting header fields:
//   col 28  FIRST OFFICIAL PRODUCTION PROOF (RUN DATE)  — populated once a bull goes official
//   col 44  LPI OFFICIAL CODE / col 58 PRODUCTION OFFICIAL CODE
//   col 63  NUMBER OF DAUGHTERS 120/90 DIM  + col 60 DAUGHTERS PROTEIN
//   col 248 GENOTYPE PANEL DENSITY — populated when the bull is genotyped
import fs from "fs";
import path from "path";
import readline from "readline";

const dir = path.join("imports", "cdn");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv"));

function idx(hdr: string[], re: RegExp) { return hdr.findIndex((h) => re.test(h.trim())); }
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

async function main() {
  // LPI OFFICIAL CODE -> { rows, withDaughters, withFirstProof, genotyped, relSum }
  const byCode = new Map<string, { rows: number; dtrs: number; fp: number; geno: number; relSum: number }>();
  const panel = new Map<string, number>();
  let rows = 0, mismatch = 0;

  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)), crlfDelay: Infinity });
    let hdr: string[] | null = null;
    let fp = -1, d1 = -1, d2 = -1, lc = -1, gp = -1, rel = -1;
    for await (const line of rl) {
      if (!hdr) {
        hdr = line.split(",");
        fp = idx(hdr, /^FIRST OFFICIAL PRODUCTION PROOF/i);
        d1 = idx(hdr, /^NUMBER OF DAUGHTERS 120/i);
        d2 = idx(hdr, /^DAUGHTERS PROTEIN$/i);
        lc = idx(hdr, /^LPI OFFICIAL CODE$/i);
        gp = idx(hdr, /^GENOTYPE PANEL DENSITY$/i);
        rel = idx(hdr, /^LPI RELIABILITY$/i);
        continue;
      }
      const c = line.split(",");
      const code = (c[lc] ?? "").trim();
      const hasFP = (c[fp] ?? "").trim() !== "" && (c[fp] ?? "").trim() !== "0";
      const dtrs = (parseInt((c[d1] ?? "").trim()) || 0) + (parseInt((c[d2] ?? "").trim()) || 0);
      const g = (c[gp] ?? "").trim();
      const r = byCode.get(code) ?? { rows: 0, dtrs: 0, fp: 0, geno: 0, relSum: 0 };
      r.rows++; if (dtrs > 0) r.dtrs++; if (hasFP) r.fp++; if (g !== "" && g !== "0") r.geno++;
      r.relSum += parseInt((c[rel] ?? "").trim()) || 0;
      byCode.set(code, r);
      bump(panel, g || "(blank)");
      // Is "official code 0" exactly "has a first official production proof"?
      if ((code === "0") !== hasFP) mismatch++;
      rows++;
    }
    rl.close();
  }

  console.log(`rows: ${rows} over ${files.length} files`);
  console.log(`rows where (LPI OFFICIAL CODE === "0") !== (FIRST OFFICIAL PRODUCTION PROOF present): ${mismatch}\n`);
  console.log("LPI OFFICIAL CODE | rows | %withDaughters | %withFirstOfficialProof | %genotyped | avgLPIrel");
  for (const [k, v] of [...byCode.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    const pc = (x: number) => `${Math.round((x / v.rows) * 100)}%`.padStart(4);
    console.log(`  "${k}" | ${String(v.rows).padStart(6)} | ${pc(v.dtrs)} | ${pc(v.fp)} | ${pc(v.geno)} | ${Math.round(v.relSum / v.rows)}`);
  }
  console.log("\nGENOTYPE PANEL DENSITY distinct:", [...panel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12));
}
main();
