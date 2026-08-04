// Diagnostic (not part of the app): where does the Projected Proof Report spend
// its time? Splits pre-existing cost (query + decode) from the analogue model,
// so any optimisation is aimed at the part that actually costs something.
//
//   npx tsx --conditions=react-server prisma/profile-forecast.ts

import { prisma } from "../src/lib/db";
import { unpackTraits, traitDefMap } from "../src/lib/eval-traits";
import { buildCorpus, forecastTrait, stepsFor, roundKindOf, type AnalogueBull } from "../src/lib/proof-analogue";
import { KEY_TRAIT_CODES } from "../src/lib/proof-change";

async function main() {
  let t = Date.now();
  const defMap = await traitDefMap();
  console.log(`  traitDefMap        ${String(Date.now() - t).padStart(6)} ms`);

  t = Date.now();
  const bulls = await prisma.animal.findMany({
    where: { archived: false, proofRoundCount: { gte: 2 }, identifiers: { some: { active: true, idType: "naab" } } },
    select: {
      id: true, primaryName: true, shortName: true, birthDate: true,
      breed: { select: { breedName: true } },
      identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } },
      evaluations: {
        orderBy: { evaluationDate: "asc" },
        select: { proofRun: true, evaluationDate: true, traitsJson: true, reliabilityOverall: true, daughters: true, sireType: true },
      },
    },
  });
  const rounds = bulls.reduce((s, b) => s + b.evaluations.length, 0);
  console.log(`  prisma query       ${String(Date.now() - t).padStart(6)} ms   (${bulls.length} bulls, ${rounds} rounds)`);

  t = Date.now();
  const decoded = bulls.map((b) => ({
    b,
    rounds: b.evaluations.map((e) => ({
      date: e.evaluationDate, reliability: e.reliabilityOverall, daughters: e.daughters, sireType: e.sireType,
      traits: new Map(unpackTraits(e.traitsJson, defMap).filter((x) => x.numericValue != null).map((x) => [x.traitCode, x.numericValue as number])),
    })),
  })).filter((x) => x.rounds.length >= 2);
  console.log(`  decode traitsJson  ${String(Date.now() - t).padStart(6)} ms`);

  const ab: AnalogueBull[] = decoded.map((x) => ({
    id: x.b.id,
    birthTime: x.b.birthDate ? x.b.birthDate.getTime() : null,
    rounds: x.rounds.map((r) => ({
      time: r.date.getTime(), kind: roundKindOf(r.date), rel: r.reliability,
      daughters: r.daughters, sireType: r.sireType, traits: r.traits,
    })),
  }));

  t = Date.now();
  const corpus = buildCorpus(ab, KEY_TRAIT_CODES);
  console.log(`  buildCorpus        ${String(Date.now() - t).padStart(6)} ms`);

  const future = Date.now() + 1e10;
  t = Date.now();
  let n = 0;
  for (const b of ab) {
    const steps = stepsFor(corpus, b);
    for (const code of KEY_TRAIT_CODES) {
      if (forecastTrait(corpus, code, b, "official", future, { stepsCache: steps })) n++;
    }
  }
  const liveMs = Date.now() - t;
  console.log(`  live forecasts     ${String(liveMs).padStart(6)} ms   (${n} forecasts, ${(liveMs / n).toFixed(2)} ms each)`);

  t = Date.now();
  let m = 0;
  for (const b of ab) {
    if (b.rounds.length < 3) continue;
    const from = Math.max(1, b.rounds.length - 6);
    for (let i = from; i < b.rounds.length; i++) {
      if (b.rounds[i].kind === "april") continue;
      for (const code of KEY_TRAIT_CODES) {
        if (forecastTrait(corpus, code, b, b.rounds[i].kind, b.rounds[i].time, { historyLength: i })) m++;
      }
    }
  }
  console.log(`  range backtest     ${String(Date.now() - t).padStart(6)} ms   (${m} forecasts)`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
