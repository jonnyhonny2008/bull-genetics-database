import fs from "fs"; import p from "path";
import { classifyProofFile } from "../src/lib/proof-file-kind";
const ROOT = "C:/Users/Jonathan/Blondin/Blondin Sires - Genetics";
const all: string[] = [];
(function w(d: string) { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) { const f = p.join(d, x.name); x.isDirectory() ? w(f) : all.push(f); } })(ROOT);
const csv = all.filter((f) => /\.csv$/i.test(f));
const tally = new Map<string, string[]>();
for (const f of csv) { const id = classifyProofFile(f);
  const k = `${id.family.padEnd(11)} kind=${String(id.kind).padEnd(8)} stud=${id.stud ?? "-"} gerun=${id.gerun ?? "-"}${id.releaseDate ? " rel" : ""} breed=${id.breed ?? "-"}`;
  const g = id.family; (tally.get(g) ?? tally.set(g, []).get(g)!).push(p.basename(f)); }
console.log(`classified ${csv.length} CSVs\n`);
for (const [k, v] of [...tally].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(v.length).padStart(5)}  ${k}`);
  for (const s of v.slice(0, 3)) console.log(`         ${s}`);
}
// Guard: nothing importable may be missing stud/gerun/breed.
const bad = csv.map((f) => ({ f, id: classifyProofFile(f) })).filter((x) => x.id.kind && (!x.id.stud || !x.id.gerun || !x.id.breed));
console.log(`\nimportable rows missing stud/gerun/breed: ${bad.length}`);
bad.slice(0, 10).forEach((b) => console.log("   ", p.basename(b.f), JSON.stringify(b.id)));
// Guard: 'other' should be genuinely non-proof files.
const other = csv.map((f) => classifyProofFile(f)).filter((i) => i.family === "other");
console.log(`\n'other' count: ${other.length}`);
csv.filter((f) => classifyProofFile(f).family === "other").slice(0, 25).forEach((f) => console.log("   ", p.basename(f)));
