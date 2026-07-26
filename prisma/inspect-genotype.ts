// Inspect the real CSVs: distinct values of "PROOF ACTIVITY CODE and GENOTYPE
// INDICATOR", correlated with daughter counts + LPI reliability, so we can tell
// genomic (GPA) bulls from progeny/daughter-proven bulls empirically.
import fs from "fs";
import path from "path";
import readline from "readline";

const dir = path.join("imports", "cdn");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).slice(0, 8);

function splitCsv(line: string): string[] { return line.split(","); }

async function main() {
  const activityCounts = new Map<string, number>();
  const activityToDtrs = new Map<string, { withDtrs: number; noDtrs: number; relSum: number; n: number }>();
  let sampleShown = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
    let hdr: string[] | null = null;
    let ai = -1, di = -1, ri = -1;
    for await (const line of rl) {
      if (!hdr) {
        hdr = splitCsv(line);
        ai = hdr.findIndex((h) => /PROOF ACTIVITY CODE/i.test(h));
        di = hdr.findIndex((h) => /NUMBER OF DAUGHTERS 120/i.test(h));
        ri = hdr.findIndex((h) => /^LPI RELIABILITY$/i.test(h));
        continue;
      }
      const cells = splitCsv(line);
      const act = (cells[ai] ?? "").trim();
      const dtrs = parseInt((cells[di] ?? "").trim()) || 0;
      const rel = parseInt((cells[ri] ?? "").trim()) || 0;
      activityCounts.set(act, (activityCounts.get(act) ?? 0) + 1);
      const rec = activityToDtrs.get(act) ?? { withDtrs: 0, noDtrs: 0, relSum: 0, n: 0 };
      if (dtrs > 0) rec.withDtrs++; else rec.noDtrs++;
      rec.relSum += rel; rec.n++;
      activityToDtrs.set(act, rec);
      if (sampleShown < 5 && act) { console.log(`sample: activity="${act}" dtrs=${dtrs} lpiRel=${rel}`); sampleShown++; }
    }
    rl.close();
  }
  console.log("\n=== PROOF ACTIVITY CODE and GENOTYPE INDICATOR — distinct values ===");
  for (const [k, v] of [...activityCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const d = activityToDtrs.get(k)!;
    console.log(`  "${k}": ${v} rows | withDaughters=${d.withDtrs} noDaughters=${d.noDtrs} | avgLPIrel=${Math.round(d.relSum / Math.max(1, d.n))}`);
  }
}
main();
