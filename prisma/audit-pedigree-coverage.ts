// READ-ONLY pedigree-coverage audit. Writes nothing. Run against production:
//
//   npx dotenv -e .env.production -- npx tsx prisma/audit-pedigree-coverage.ts
//
// Answers the questions the mating report's safety rules depend on:
//   * how many ancestor slots do we actually hold per animal (0..14)?
//   * how complete are those pedigrees (MacCluer, generation-weighted)?
//   * how often does an animal's SIRE resolve to an Animal row of his own —
//     the recursion that is the ONLY way to reach the paternal grandparents?
//   * of every registration number named in the pedigree text, how many are
//     animals we hold (i.e. how much alias expansion can ever fire)?
//   * on a real sample of pairings, what share land in each tier — how many
//     bulls would actually be recommendable, excluded, or unverifiable.
//
// It uses the SAME engine the report uses (src/lib/relatedness.ts), so the
// numbers below cannot drift from what the report will do.

import { PrismaClient } from "@prisma/client";
import { parsePedigreeNotes } from "../src/lib/pedigree";
import {
  buildCorpus, buildAncestorSet, assessRelatedness, normalizeReg,
  type AncestorSet, type PedigreeCorpus, type Tier,
} from "../src/lib/relatedness";

const prisma = new PrismaClient();

const MAX_GEN = 3 as const;
const FLOOR = 0.75;
const SAMPLE_FEMALES = 25;
const SAMPLE_BULLS = 40;

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
const bar = (n: number, max: number, width = 40) =>
  "#".repeat(max > 0 ? Math.round((n / max) * width) : 0);

function histogram(title: string, labels: string[], counts: number[], total: number) {
  const max = Math.max(...counts, 1);
  console.log(`\n${title}`);
  console.log("-".repeat(78));
  for (let i = 0; i < labels.length; i++) {
    console.log(
      `${labels[i].padEnd(12)} ${String(counts[i]).padStart(6)}  ${pct(counts[i], total).padStart(7)}  ${bar(counts[i], max)}`,
    );
  }
}

async function main() {
  // --- corpus ---------------------------------------------------------------
  // Built here rather than via loadPedigreeCorpus() so the audit can show what
  // the raw identifier table does to the screen BEFORE any hygiene is applied.
  const idRowsRaw = await prisma.animalIdentifier.findMany({
    where: { active: true },
    select: { animalId: true, idValue: true, idType: true },
  });
  const pedNoteRows = await prisma.pedigreeReference.findMany({ select: { animalId: true, notes: true } });

  // An identifier that belongs to more than one animal identifies none of them.
  const owners = new Map<string, Set<string>>();
  const typeOfKey = new Map<string, Set<string>>();
  for (const r of idRowsRaw) {
    const key = normalizeReg(r.idValue);
    if (!key) continue;
    (owners.get(key) ?? owners.set(key, new Set()).get(key)!).add(r.animalId);
    (typeOfKey.get(key) ?? typeOfKey.set(key, new Set()).get(key)!).add(r.idType);
  }
  const ambiguous = [...owners.entries()].filter(([, s]) => s.size > 1);

  // buildCorpus applies the hygiene itself: an ambiguous key stays in the
  // animal's OWN identity (so "this bull is her sire" still fires on a
  // duplicate-imported sire) but is never resolved and never alias-expanded.
  // `keepAmbiguous` is the audit-only switch that shows what the raw table does.
  const rawCorpus = buildCorpus(idRowsRaw, pedNoteRows, { keepAmbiguous: true });
  const corpus: PedigreeCorpus = buildCorpus(idRowsRaw, pedNoteRows);

  const [animalTotal, animalLive, femalesLive, males, blondin, pedRows] = await Promise.all([
    prisma.animal.count(),
    prisma.animal.count({ where: { archived: false } }),
    prisma.animal.count({ where: { archived: false, sex: "F" } }),
    prisma.animal.count({ where: { archived: false, sex: "M" } }),
    prisma.animalRole.count({ where: { roleType: "blondin", active: true } }),
    prisma.pedigreeReference.count(),
  ]);

  console.log(`\n=== PEDIGREE COVERAGE AUDIT (read-only) ===`);
  console.log(`animals: ${animalTotal} (${animalLive} not archived — ${males} M, ${femalesLive} F)`);
  console.log(`PedigreeReference rows: ${pedRows}; animals with a usable pedigree line: ${corpus.notesByAnimalId.size}`);
  console.log(`expandable (unambiguous) identifiers: ${[...corpus.aliasRegsByAnimalId.values()].reduce((a, b) => a + b.length, 0)} over ${corpus.aliasRegsByAnimalId.size} animals`);
  console.log(`blondin-role animals: ${blondin}`);

  // --- identifier hygiene ----------------------------------------------------
  // Alias expansion is only safe while an identifier names exactly one animal.
  console.log(`\nIDENTIFIER HYGIENE — can every active identifier be used as an alias?`);
  console.log("-".repeat(78));
  console.log(`  active identifier rows: ${idRowsRaw.length} over ${owners.size} distinct normalized keys`);
  console.log(`  keys owned by MORE THAN ONE animal: ${ambiguous.length}`);
  for (const [key, set] of ambiguous.sort((a, b) => b[1].size - a[1].size).slice(0, 10)) {
    console.log(`     "${key}"  ->  ${set.size} animals   [idType ${[...(typeOfKey.get(key) ?? [])].join(", ")}]`);
  }
  const poisoned = new Set<string>();
  for (const [, set] of ambiguous) for (const id of set) poisoned.add(id);
  console.log(`  animals carrying at least one ambiguous identifier: ${poisoned.size}  (${pct(poisoned.size, animalLive)} of the live herd)`);
  console.log(`  -> these keys are never resolved and never alias-expanded below. Expanded they`);
  console.log(`     would make every animal sharing the key look like the same animal`);
  console.log(`     (all-vs-all false exclusions). They DO stay in each owner's own identity,`);
  console.log(`     so a duplicate-imported sire is still caught as "this bull is her sire".`);

  // --- every non-archived animal's ancestor set ------------------------------
  const animals = await prisma.animal.findMany({
    where: { archived: false },
    select: { id: true, primaryName: true, sex: true },
  });

  const sets = new Map<string, AncestorSet>();
  for (const a of animals) sets.set(a.id, buildAncestorSet(a.id, corpus, MAX_GEN));

  // slots 0..14
  const slotCounts = new Array(15).fill(0);
  for (const s of sets.values()) slotCounts[Math.min(s.slots, 14)]++;
  histogram(
    "SLOTS — distinct ancestors carrying a registration number (0..14)",
    slotCounts.map((_, i) => `${i} slot${i === 1 ? "" : "s"}`),
    slotCounts,
    sets.size,
  );

  // pedComplete deciles
  const decLabels = ["0.0–0.1", "0.1–0.2", "0.2–0.3", "0.3–0.4", "0.4–0.5", "0.5–0.6", "0.6–0.7", "0.7–0.8", "0.8–0.9", "0.9–1.0"];
  const dec = new Array(10).fill(0);
  for (const s of sets.values()) dec[Math.min(9, Math.floor(s.pedComplete * 10))]++;
  histogram("PEDIGREE COMPLETENESS (MacCluer, generation-weighted) — deciles", decLabels, dec, sets.size);

  const distinct = new Map<string, number>();
  for (const s of sets.values()) {
    const k = s.pedComplete.toFixed(3);
    distinct.set(k, (distinct.get(k) ?? 0) + 1);
  }
  console.log(`\nEXACT completeness values (0.583 = own notes only / sire unresolved, 0.833 = sire resolves, 1.000 = full 14 slots)`);
  console.log("-".repeat(78));
  for (const [v, n] of [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${v}   ${String(n).padStart(6)}  ${pct(n, sets.size).padStart(7)}`);
  }
  const above = [...sets.values()].filter((s) => s.pedComplete >= FLOOR).length;
  console.log(`\n  at or above the ${FLOOR} certification floor: ${above} / ${sets.size}  (${pct(above, sets.size)})`);

  // --- resolvable sire -------------------------------------------------------
  // The recursion into the sire's own PedigreeReference row is the only route to
  // the paternal grandparents. Without it generations 2-3 are half blind.
  let withNotes = 0, sireNamed = 0, sireHasReg = 0, sireResolves = 0;
  const ancestorRegs = new Map<string, number>(); // normalized reg -> times named
  for (const [animalId, notes] of corpus.notesByAnimalId) {
    if (!sets.has(animalId)) continue; // archived
    withNotes++;
    for (const a of parsePedigreeNotes(notes)) {
      const reg = normalizeReg(a.reg);
      if (reg) ancestorRegs.set(reg, (ancestorRegs.get(reg) ?? 0) + 1);
      if (a.relation !== "sire") continue;
      if (a.name || reg) sireNamed++;
      if (!reg) continue;
      sireHasReg++;
      const sireId = corpus.regToAnimalId.get(reg);
      if (sireId && corpus.notesByAnimalId.has(sireId)) sireResolves++;
    }
  }
  console.log(`\nSIRE RESOLUTION — can we recurse into the sire's own pedigree?`);
  console.log("-".repeat(78));
  console.log(`  animals with a usable pedigree line:        ${withNotes}`);
  console.log(`  ... naming a sire:                          ${sireNamed}  (${pct(sireNamed, withNotes)})`);
  console.log(`  ... whose sire carries a registration:      ${sireHasReg}  (${pct(sireHasReg, withNotes)})`);
  console.log(`  ... whose sire is a HELD animal WITH notes: ${sireResolves}  (${pct(sireResolves, withNotes)} of pedigreed, ${pct(sireResolves, sets.size)} of all)`);
  console.log(`  -> the rest are paternally blind at generations 2-3.`);

  // --- ancestor-key resolve rate --------------------------------------------
  let resolved = 0, resolvedMentions = 0, totalMentions = 0;
  for (const [reg, times] of ancestorRegs) {
    totalMentions += times;
    if (corpus.regToAnimalId.has(reg)) { resolved++; resolvedMentions += times; }
  }
  console.log(`\nANCESTOR-KEY RESOLVE RATE — how many named ancestors are animals we hold`);
  console.log("-".repeat(78));
  console.log(`  distinct ancestor registrations named: ${ancestorRegs.size}`);
  console.log(`  ... that are an Animal row:            ${resolved}  (${pct(resolved, ancestorRegs.size)})`);
  console.log(`  by mention: ${resolvedMentions} / ${totalMentions}  (${pct(resolvedMentions, totalMentions)})`);
  console.log(`  (comparison keys are registration STRINGS for exactly this reason —`);
  console.log(`   an animalId-keyed comparison would see only the ${pct(resolved, ancestorRegs.size)} above.)`);

  // --- tier distribution on a real sample of pairings ------------------------
  // Females first (the report's input); if the database holds too few, fall back
  // to sampling bulls on the "cow" side and say so.
  let femaleRows = await prisma.animal.findMany({
    where: { archived: false, sex: "F" },
    select: { id: true, primaryName: true },
    take: SAMPLE_FEMALES,
  });
  let femaleNote = `${femaleRows.length} females`;
  if (femaleRows.length < 5) {
    const filler = await prisma.animal.findMany({
      where: { archived: false, sex: "M", id: { notIn: femaleRows.map((f) => f.id) } },
      select: { id: true, primaryName: true },
      take: SAMPLE_FEMALES - femaleRows.length,
    });
    femaleRows = [...femaleRows, ...filler];
    femaleNote = `${femaleRows.length} animals (too few females on file — MALES SUBSTITUTED on the female side, structure only)`;
  }

  const blondinIds = (await prisma.animalRole.findMany({
    where: { roleType: "blondin", active: true, animal: { archived: false, sex: "M" } },
    select: { animalId: true },
    take: SAMPLE_BULLS,
  })).map((r) => r.animalId);
  let bullRows = await prisma.animal.findMany({
    where: { archived: false, sex: "M", id: { in: blondinIds } },
    select: { id: true, primaryName: true },
  });
  let poolNote = `blondin pool (${bullRows.length})`;
  if (bullRows.length < 5) {
    bullRows = await prisma.animal.findMany({
      where: { archived: false, sex: "M", proofStatus: "active" },
      select: { id: true, primaryName: true },
      take: SAMPLE_BULLS,
    });
    poolNote = `active bulls (${bullRows.length}) — blondin role too small`;
  }

  const tierOrder: Tier[] = ["clear", "excluded", "unknown", "no-pedigree"];

  function runPairs(c: PedigreeCorpus) {
    const tiers: Record<Tier, number> = { excluded: 0, clear: 0, unknown: 0, "no-pedigree": 0 };
    const cache = new Map<string, AncestorSet>();
    const setFor = (id: string) => {
      let s = cache.get(id);
      if (!s) { s = buildAncestorSet(id, c, MAX_GEN); cache.set(id, s); }
      return s;
    };
    let pairs = 0, closest: { label: string; sum: number } | null = null;
    const excludedPerFemale = new Map<string, number>();
    for (const f of femaleRows) {
      const cow = setFor(f.id);
      for (const b of bullRows) {
        if (b.id === f.id) continue;
        const v = assessRelatedness(cow, setFor(b.id), { maxGen: MAX_GEN, floor: FLOOR });
        tiers[v.tier]++;
        pairs++;
        if (v.tier === "excluded") {
          excludedPerFemale.set(f.id, (excludedPerFemale.get(f.id) ?? 0) + 1);
          const sum = v.closestSum ?? 99;
          if (!closest || sum < closest.sum) {
            closest = { label: `${f.primaryName} × ${b.primaryName}: ${v.shared[0].label} (${v.shared[0].name ?? v.shared[0].reg})`, sum };
          }
        }
      }
    }
    return { tiers, pairs, closest, excludedPerFemale };
  }

  const clean = runPairs(corpus);
  const raw = runPairs(rawCorpus);

  console.log(`\nTIER DISTRIBUTION — sample pairing, D=${MAX_GEN}, floor ${FLOOR}`);
  console.log(`  female side: ${femaleNote}`);
  console.log(`  bull pool:   ${poolNote}`);
  console.log("-".repeat(78));
  histogram(`  ${clean.pairs} pairings (ambiguous identifiers dropped)`, tierOrder, tierOrder.map((t) => clean.tiers[t]), clean.pairs);
  console.log(`\n  RECOMMENDABLE (tier "clear") = ${pct(clean.tiers.clear, clean.pairs)} of pairings.`);
  console.log(`  withheld as unverifiable      = ${pct(clean.tiers.unknown + clean.tiers["no-pedigree"], clean.pairs)}`);
  if (clean.closest) console.log(`  closest relationship found:   ${clean.closest.label}`);
  const zeroClear = femaleRows.filter((f) => (clean.excludedPerFemale.get(f.id) ?? 0) === bullRows.length).length;
  if (zeroClear) console.log(`  females with EVERY bull excluded: ${zeroClear}`);

  histogram(`  SAME PAIRINGS, ambiguous identifiers KEPT (what the raw table does)`, tierOrder, tierOrder.map((t) => raw.tiers[t]), raw.pairs);
  console.log(`\n  clear ${pct(clean.tiers.clear, clean.pairs)} -> ${pct(raw.tiers.clear, raw.pairs)},  excluded ${pct(clean.tiers.excluded, clean.pairs)} -> ${pct(raw.tiers.excluded, raw.pairs)}`);
  if (raw.closest) console.log(`  raw closest "relationship": ${raw.closest.label}`);

  console.log("");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
