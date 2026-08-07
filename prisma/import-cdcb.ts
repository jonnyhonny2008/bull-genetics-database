// ---------------------------------------------------------------------------
// Import a CDCB round into the American side.
//
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server \
//     prisma/import-cdcb.ts <folder-or-zip-dir> [--breed HO] [--dry-run]
//
// Point it at a folder holding extracted CDCB member files, e.g.
//   AY_all_evaluated_infoANIM_2604.csv + AY_all_evaluated_infoEVAL_2604.csv
// It pairs them by family+date, classifies each pair from the FILE NAME (the only
// reliable source of run kind — see file-kind.ts), parses, and persists.
//
// --dry-run parses and reports WITHOUT writing anything, which is the honest way
// to check a new round before it touches the database.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCdcbPairText, CdcbParseError } from "../src/lib/us-cdcb/parse";
import { classifyCdcbFile, cdcbRoundLabel } from "../src/lib/us-cdcb/file-kind";
import { computeTpi, TpiUnavailable } from "../src/lib/us-cdcb/index-registry";
import { computeJpi, JpiUnavailable } from "../src/lib/us-cdcb/jpi";

// NOTE: the persistence layer is imported DYNAMICALLY, below, only when actually
// writing. It pulls in src/lib/db.ts, which constructs a PrismaClient at module
// load — so a static import would make --dry-run require a live DATABASE_URL,
// defeating the entire point of being able to check a new round before it goes
// anywhere near the database.

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const breedArg = (() => { const i = args.indexOf("--breed"); return i >= 0 ? args[i + 1]?.toUpperCase() : null; })();

if (!dir || !existsSync(dir)) {
  console.error("usage: import-cdcb.ts <folder with extracted CDCB csv files> [--breed HO] [--dry-run]");
  process.exit(1);
}

/** Pair infoANIM with infoEVAL by everything except the ANIM/EVAL token. */
function findPairs(folder: string) {
  const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".csv"));
  const pairs: { key: string; anim: string; evalF: string }[] = [];
  for (const f of files) {
    if (!/_infoANIM_/i.test(f)) continue;
    const partner = f.replace(/_infoANIM_/i, "_infoEVAL_");
    if (files.includes(partner)) pairs.push({ key: f.replace(/_infoANIM_/i, "_"), anim: f, evalF: partner });
  }
  return pairs;
}

async function main() {
  const persist = dryRun ? null : await import("../src/lib/us-cdcb/persist");
  // Hoisted: the preferred-evaluation recompute at the end of the run needs both.
  const bulk = dryRun ? null : await import("../src/lib/us-cdcb/persist-bulk");
  const db = dryRun ? null : await import("../src/lib/db");
  const pairs = findPairs(dir!);
  if (!pairs.length) {
    console.error(`No infoANIM/infoEVAL pairs found in ${dir}`);
    process.exit(1);
  }

  let totalAnimals = 0, totalCreated = 0, totalLinked = 0, totalConflicts = 0, totalTpi = 0, totalJpi = 0;
  const touched = new Set<string>();
  const bulkTouched: string[] = [];

  for (const p of pairs) {
    const id = classifyCdcbFile(p.evalF);
    if (!id.family || !id.kind) { console.log(`SKIP  ${p.evalF} — not a recognised CDCB extract`); continue; }
    if (breedArg && id.breed !== breedArg) continue;

    let parsed;
    try {
      parsed = parseCdcbPairText(readFileSync(join(dir!, p.anim), "utf8"), readFileSync(join(dir!, p.evalF), "utf8"));
    } catch (e) {
      // A parse failure is loud and stops this file — a partially-read round is
      // worse than an un-imported one.
      console.error(`FAIL  ${p.evalF}: ${e instanceof CdcbParseError ? e.message : e}`);
      process.exitCode = 1;
      continue;
    }

    console.log(`\n${p.evalF}`);
    console.log(`      ${id.breed} · ${cdcbRoundLabel(id)} · ${id.family} · ${id.kind} · period ${id.periodKey}`);
    console.log(`      ${parsed.animals.length} animals · ${parsed.traitCodes.length} traits · ${parsed.infoKeys.length} info keys`);

    if (dryRun) {
      // Actually COMPUTE the indexes so a new round is proven end to end before
      // it is allowed near the database — a dry run that only counts rows would
      // miss exactly the failures that matter (an unknown formula version, a
      // trait CDCB stopped publishing).
      const withNaab = parsed.animals.filter((a) => (a.info.NAAB_CODE ?? "").trim()).length;
      const sexes = new Set(parsed.animals.map((a) => a.info.SEX));
      let tpiN = 0, jpiN = 0, idxNull = 0;
      const vals: number[] = [];
      if (id.roundCode) {
        for (const a of parsed.animals) {
          const flat: Record<string, number | null> = {};
          for (const [c, v] of Object.entries(a.traits)) flat[c] = v.gpta;
          try {
            if (id.breed === "HO") { const r = computeTpi(flat, id.roundCode); if (r) { tpiN++; vals.push(r.value); } else idxNull++; }
            if (id.breed === "JE") { const r = computeJpi(flat, id.roundCode); if (r) { jpiN++; vals.push(r.value); } else idxNull++; }
          } catch (e) {
            if (!(e instanceof TpiUnavailable) && !(e instanceof JpiUnavailable)) throw e;
          }
        }
      }
      const range = vals.length ? ` range ${Math.min(...vals)}..${Math.max(...vals)}` : "";
      console.log(`      DRY RUN — nothing written. NAAB present: ${withNaab}. SEX: ${[...sexes].join(",")}`);
      if (id.breed === "HO" || id.breed === "JE") {
        console.log(`      index: ${tpiN + jpiN} computed, ${idxNull} not computable${range}`);
      }
      totalAnimals += parsed.animals.length;
      continue;
    }

    // BULK path: a fixed number of queries per file rather than ~6 per animal.
    // The Holstein round alone is 51,497 animals, so per-animal writes would be
    // ~300,000 round-trips to a remote database.
    const r = await bulk!.persistCdcbRound(parsed.animals, id, {
      sourceFile: p.evalF,
      onProgress: (done, total) => { if (done % 5000 === 0 || done === total) console.log(`      … ${done}/${total}`); },
    });
    totalAnimals += r.animals;
    totalCreated += r.createdAnimals;
    totalLinked += r.linked;
    totalConflicts += r.conflicts.length;
    totalTpi += r.withTpi;
    totalJpi += r.withJpi;
    for (const c of r.conflicts.slice(0, 5)) console.log(`      CONFLICT ${c.id17}: ${c.reason}`);
    if (r.conflicts.length > 5) console.log(`      … and ${r.conflicts.length - 5} more conflicts`);
    console.log(`      wrote ${r.evaluations} evaluations (${r.createdAnimals} new animals, ${r.linked} linked)`);
    bulkTouched.push(...parsed.animals.map((a) => a.id17));
  }

  // The AI-status file, if it is sitting alongside — it decides "active" on this
  // side, replacing the Canadian has-a-NAAB-code rule.
  const statusFile = readdirSync(dir!).find((f) => /^aistatus\./i.test(f));
  if (statusFile && !dryRun) {
    const round = pairs.map((p) => classifyCdcbFile(p.evalF).roundCode).find(Boolean);
    if (round) {
      const r = await persist!.persistAiStatus(readFileSync(join(dir!, statusFile), "utf8").split(/\r?\n/), round);
      console.log(`\naistatus: ${r.rows} rows, ${r.matched} matched to an imported animal`);
    }
  }

  if (!dryRun) {
    // THIS STEP USED TO DO NOTHING. It looped over `touched`, which the bulk path
    // never populates — the bulk path collects id17s in `bulkTouched` — so the set
    // was always empty and isPreferred stayed false on every row imported. The US
    // lineup reads isPreferred, so a "successful" import produced an empty list.
    //
    // Resolve the id17s this run wrote to their UsAnimal ids and hand the whole
    // set to the bulk recompute, rather than awaiting once per animal: at 70,000
    // animals that difference is minutes against hours.
    const ids = [...new Set(bulkTouched)];
    const usAnimalIds: string[] = [];
    for (let i = 0; i < ids.length; i += 2000) {
      const rows = await db!.prisma.usAnimal.findMany({
        where: { id17: { in: ids.slice(i, i + 2000) } },
        select: { usAnimalId: true },
      });
      usAnimalIds.push(...rows.map((r) => r.usAnimalId));
    }
    console.log(`\nrecomputing preferred US evaluation for ${usAnimalIds.length} animals…`);
    const n = await bulk!.recomputeUsPreferredBulk(usAnimalIds);
    console.log(`  ${n} marked preferred`);
    // The single-animal path is still used by the agent and the review queue.
    for (const id of touched) await persist!.recomputeUsPreferred(id);
  }

  console.log(`\n${dryRun ? "DRY RUN " : ""}TOTAL: ${totalAnimals} animals · ${totalCreated} new · ${totalLinked} linked · ${totalConflicts} conflicts · TPI ${totalTpi} · JPI ${totalJpi}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
