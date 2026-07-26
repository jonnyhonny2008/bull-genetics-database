import fs from "fs";
import { parseHolsteinAis } from "../src/lib/holstein";

const text = fs.readFileSync(new URL("./sample-ais.txt", import.meta.url), "utf8");
const p = parseHolsteinAis(text);
console.log("NAME:", p.name, "| REG:", p.regNo, "| NATID:", p.nationalId, "| SEX:", p.sex, "| BORN:", p.birthDate);
console.log("PURITY:", p.purity, "| HERD:", p.herdNo, "| COLOUR:", p.colour, "| A2:", p.betaCasein, "| INB:", p.inbreeding, "| R:", p.rValue);
console.log("CLASS:", JSON.stringify(p.classification), "| SECTIONS:", p.classificationSections.map(s => `${s.name}=${s.value}`).join(", "));
console.log("EVAL:", JSON.stringify(p.evaluation));
console.log("PEDIGREE:", p.pedigree.map(x => `${x.relation}:${x.name}(${x.reg})`).join(" | "));
console.log("TRAITS (" + p.traits.length + "):");
for (const t of p.traits) console.log("  ", t.code.padEnd(8), t.numericValue ?? "", t.textValue ?? "", t.reliability != null ? `rel=${t.reliability}` : "", t.percentileRank != null ? `pct=${t.percentileRank}` : "");
console.log("WARNINGS:", p.warnings);
