// Copy exactly the OFFICIAL Lactanet stud files out of the Blondin archive into a
// clean stage dir, so import-cdn imports them and nothing else. Interim/bare/
// pregeno/cows/private files are left behind — the interim data is already in the
// DB, and the classifier decides membership so this cannot drift from the importer.
import fs from "fs";
import path from "path";
import { classifyProofFile } from "../src/lib/proof-file-kind";

const ROOT = process.env.BLONDIN_ROOT || "C:/Users/Jonathan/Blondin/Blondin Sires - Genetics";
const OUT = process.argv[2] || path.join(process.env.IMPORTS_DIR || "./imports", "officials");

function walk(d: string, out: string[] = []): string[] {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const x of e) { const f = path.join(d, x.name); x.isDirectory() ? walk(f, out) : out.push(f); }
  return out;
}

function main() {
  const officials = walk(ROOT).filter((f) => /\.csv$/i.test(f) && classifyProofFile(f).family === "official");
  fs.mkdirSync(OUT, { recursive: true });
  // Clear any prior contents so a re-run is deterministic.
  for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));

  // A round×breed may have several dated re-releases; keep the plain settled file
  // when present, else the first. import-cdn dedups on (animal|label|kind) anyway,
  // but staging one file per round×breed keeps the log readable.
  const chosen = new Map<string, string>();
  for (const f of officials) {
    const id = classifyProofFile(f);
    const key = `${id.gerun}|${id.breed}`;
    if (!chosen.has(key) || !id.releaseDate) chosen.set(key, f);
  }

  let n = 0;
  const byRound = new Map<string, number>();
  for (const src of chosen.values()) {
    const id = classifyProofFile(src);
    // Keep the ORIGINAL basename — the classifier reads the name, and only the
    // "gealltraits_bulls<stud>" form (no _unoff) reads as official. Renaming to
    // anything else silently reclassifies the file as interim. Basenames are
    // unique per round×breed within the chosen set, so no collision in the flat dir.
    const dest = path.join(OUT, path.basename(src));
    fs.copyFileSync(src, dest);
    // Belt and braces: assert the copy still classifies as official.
    if (classifyProofFile(dest).kind !== "official") throw new Error(`staged file lost its official kind: ${dest}`);
    n++;
    byRound.set(id.gerun ?? "?", (byRound.get(id.gerun ?? "?") ?? 0) + 1);
  }
  console.log(`[stage-officials] staged ${n} official files to ${OUT}`);
  console.log(`[stage-officials] ${byRound.size} distinct rounds (GERUN): ${[...byRound.keys()].sort().join(" ")}`);
}
main();
