// Diagnostic tooling (not part of the app): dump every NAAB bull's proof history
// to a flat JSON file so forecasting experiments can run against a single frozen
// dataset instead of each one re-querying the database.
//
//   npx tsx --conditions=react-server prisma/export-forecast-data.ts <out.json>
//
// One dump, many experiments: results stay directly comparable, runs are fast
// and repeatable, and a dozen concurrent experiments cannot exhaust the
// connection pool.

import fs from "fs";
import { prisma } from "../src/lib/db";
import { unpackTraits, traitDefMap } from "../src/lib/eval-traits";
import { isRollbackRound, isOfficialProof } from "../src/lib/rollback";

const out = process.argv[2];
if (!out) { console.error("usage: export-forecast-data.ts <out.json>"); process.exit(1); }

async function main() {
  const defMap = await traitDefMap();
  const bulls = await prisma.animal.findMany({
    where: {
      archived: false,
      identifiers: { some: { active: true, idType: "naab" } },
    },
    select: {
      id: true, primaryName: true, shortName: true, birthDate: true,
      sireType: true, proofRoundCount: true,
      breed: { select: { breedName: true } },
      identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } },
      roles: { where: { active: true }, select: { roleType: true } },
      evaluations: {
        orderBy: { evaluationDate: "asc" },
        select: {
          evaluationDate: true, proofRun: true, reliabilityOverall: true,
          daughters: true, herds: true, sireType: true, genotyped: true,
          activityCode: true, officialCode: true, traitsJson: true,
        },
      },
    },
  });

  const data = {
    exportedAt: new Date().toISOString(),
    bulls: bulls.map((b) => ({
      id: b.id,
      name: b.primaryName,
      shortName: b.shortName,
      naab: b.identifiers.find((i) => i.idType === "naab")?.idValue ?? null,
      reg: b.identifiers.find((i) => i.isPrimary)?.idValue ?? null,
      breed: b.breed?.breedName ?? null,
      birthDate: b.birthDate ? b.birthDate.toISOString() : null,
      sireType: b.sireType,
      blondin: b.roles.some((r) => r.roleType === "blondin"),
      rounds: b.evaluations.map((e) => {
        const traits: Record<string, { v: number | null; r: number | null; p: number | null }> = {};
        for (const t of unpackTraits(e.traitsJson, defMap)) {
          traits[t.traitCode] = { v: t.numericValue, r: t.reliability, p: t.percentileRank };
        }
        return {
          date: e.evaluationDate.toISOString(),
          time: e.evaluationDate.getTime(),
          run: e.proofRun,
          kind: isRollbackRound(e.evaluationDate) ? "april" : isOfficialProof(e.evaluationDate) ? "official" : "interim",
          rel: e.reliabilityOverall,
          daughters: e.daughters,
          herds: e.herds,
          sireType: e.sireType,
          genotyped: e.genotyped,
          activityCode: e.activityCode,
          officialCode: e.officialCode,
          traits,
        };
      }),
    })),
  };

  fs.writeFileSync(out, JSON.stringify(data));
  const rounds = data.bulls.reduce((s, b) => s + b.rounds.length, 0);
  console.log(`wrote ${out}`);
  console.log(`  bulls  : ${data.bulls.length}`);
  console.log(`  rounds : ${rounds}`);
  console.log(`  size   : ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  const codes = new Set<string>();
  for (const b of data.bulls) for (const r of b.rounds) for (const c of Object.keys(r.traits)) codes.add(c);
  console.log(`  traits : ${codes.size} distinct codes`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
