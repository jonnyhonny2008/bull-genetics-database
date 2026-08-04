// Verification (not part of the app): does the SHIPPED TypeScript module
// reproduce the accuracy measured during research?
//
//   npx tsx --conditions=react-server prisma/verify-analogue.ts <rounds.json>
//
// The research ran in standalone JS. This runs the real `src/lib/proof-analogue`
// against the same frozen dataset, walk-forward, and scores it the same way, so
// a porting mistake cannot hide behind a plausible-looking report.
//
// Expected: roughly +2.8% CRPS improvement over the cohort-wide band that this
// report used to publish (research measured +2.94% with two extra features that
// were deliberately dropped for robustness — see proof-analogue.ts).

import fs from "fs";
import {
  buildCorpus, forecastTrait, stepsFor, quantileOf, QUANTILES,
  type AnalogueBull, type RoundKind,
} from "../src/lib/proof-analogue";

const KEY_CODES = ["CONF", "LPI", "MILK", "FAT", "FATPCT", "PROT", "PROTPCT", "MSPD", "DF"];
const LABELS: Record<string, string> = {
  CONF: "Conformation", LPI: "LPI", MILK: "Milk", FAT: "Fat", FATPCT: "Fat %",
  PROT: "Protein", PROTPCT: "Protein %", MSPD: "Milking Speed", DF: "Daughter Fertility",
};

const path = process.argv[2];
if (!path) { console.error("usage: verify-analogue.ts <rounds.json>"); process.exit(1); }

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const pinball = (actual: number, pred: number, q: number) =>
  actual >= pred ? q * (actual - pred) : (1 - q) * (pred - actual);
const crps = (actual: number, qv: number[]) =>
  mean(QUANTILES.map((q, i) => pinball(actual, qv[i], q)));

interface RawRound {
  time: number; kind: RoundKind; rel: number | null; daughters: number | null;
  herds: number | null; sireType: string | null;
  traits: Record<string, { v: number | null; r: number | null; p: number | null }>;
}

function main() {
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as {
    bulls: { id: string; birthDate: string | null; rounds: RawRound[] }[];
  };

  const bulls: AnalogueBull[] = raw.bulls.map((b) => ({
    id: b.id,
    birthTime: b.birthDate ? Date.parse(b.birthDate) : null,
    rounds: b.rounds.map((r) => {
      const traits = new Map<string, number>();
      for (const [code, t] of Object.entries(r.traits)) if (t.v != null) traits.set(code, t.v);
      return { time: r.time, kind: r.kind, rel: r.rel, daughters: r.daughters, sireType: r.sireType, traits };
    }),
  })).filter((b) => b.rounds.length >= 2);

  const t0 = Date.now();
  const corpus = buildCorpus(bulls, KEY_CODES);
  const buildMs = Date.now() - t0;

  // Walk-forward cutoff: skip the first 8 distinct rounds so there is a corpus
  // to match against at all.
  const allTimes = [...new Set(bulls.flatMap((b) => b.rounds.map((r) => r.time)))].sort((a, b) => a - b);
  const cutoff = allTimes[Math.min(8, allTimes.length - 1)];

  // The incumbent: cohort-wide quantiles over EARLIER same-kind moves only.
  const cohortMoves = new Map<string, { time: number; kind: RoundKind; move: number }[]>();
  for (const code of KEY_CODES) {
    const arr: { time: number; kind: RoundKind; move: number }[] = [];
    for (const b of bulls) {
      for (let i = 1; i < b.rounds.length; i++) {
        if (b.rounds[i].kind === "april") continue;
        const p = b.rounds[i - 1].traits.get(code), q = b.rounds[i].traits.get(code);
        if (p != null && q != null) arr.push({ time: b.rounds[i].time, kind: b.rounds[i].kind, move: q - p });
      }
    }
    arr.sort((x, y) => x.time - y.time);
    cohortMoves.set(code, arr);
  }

  console.log(`\n  corpus built in ${buildMs} ms — ${bulls.length} bulls, ${KEY_CODES.length} traits`);
  console.log(`\n${"=".repeat(96)}`);
  console.log(`  SHIPPED MODULE, walk-forward — analogue band vs the cohort-wide band it replaces`);
  console.log(`${"=".repeat(96)}`);
  console.log(`  ${"trait".padEnd(20)}${"n".padStart(7)}${"CRPS cohort".padStart(14)}${"CRPS analogue".padStart(15)}${"skill".padStart(9)}${"cover".padStart(8)}${"fallbacks".padStart(11)}`);

  let totA = 0, totC = 0, totN = 0;
  const perTrait: { label: string; skill: number }[] = [];

  for (const code of KEY_CODES) {
    const moves = cohortMoves.get(code)!;
    const aCrps: number[] = [], cCrps: number[] = [];
    let hit = 0, fallbacks = 0, n = 0;

    for (const b of bulls) {
      const steps = stepsFor(corpus, b);
      for (let i = 1; i < b.rounds.length; i++) {
        const cur = b.rounds[i];
        if (cur.kind === "april" || cur.time < cutoff) continue;
        const last = b.rounds[i - 1].traits.get(code);
        const actual = cur.traits.get(code);
        if (last == null || actual == null) continue;

        const f = forecastTrait(corpus, code, b, cur.kind, cur.time, { stepsCache: steps, historyLength: i });
        if (!f) continue;

        // Incumbent band from earlier same-kind moves only.
        const earlier = moves.filter((m) => m.time < cur.time && m.kind === cur.kind).map((m) => m.move).sort((x, y) => x - y);
        if (earlier.length < 30) continue;
        const cq = QUANTILES.map((q) => last + quantileOf(earlier, q));

        aCrps.push(crps(actual, f.quantiles));
        cCrps.push(crps(actual, cq));
        if (actual >= f.lo && actual <= f.hi) hit++;
        if (f.basis === "cohort") fallbacks++;
        n++;
      }
    }
    if (!n) { console.log(`  ${LABELS[code].padEnd(20)} — no scored cases`); continue; }
    const a = mean(aCrps), c = mean(cCrps);
    const skill = c > 0 ? ((c - a) / c) * 100 : 0;
    perTrait.push({ label: LABELS[code], skill });
    totA += a * n; totC += c * n; totN += n;
    console.log(
      `  ${LABELS[code].padEnd(20)}${String(n).padStart(7)}${c.toFixed(4).padStart(14)}${a.toFixed(4).padStart(15)}` +
      `${(skill.toFixed(2) + "%").padStart(9)}${((hit / n * 100).toFixed(1) + "%").padStart(8)}${String(fallbacks).padStart(11)}`,
    );
  }

  const overall = totC > 0 ? ((totC - totA) / totC) * 100 : 0;
  console.log(`  ${"".padEnd(20)}${"".padStart(7)}${"".padStart(14)}${"OVERALL".padStart(15)}${(overall.toFixed(2) + "%").padStart(9)}`);
  console.log(`\n  scored ${totN} predictions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const worst = perTrait.filter((p) => p.skill <= 0);
  console.log(worst.length
    ? `\n  WARNING: ${worst.length} trait(s) did not improve: ${worst.map((w) => w.label).join(", ")}`
    : `\n  All ${perTrait.length} traits improved on the cohort band.`);
  console.log(overall > 2.0
    ? `  PASS — the port reproduces the researched accuracy (expected ≈ +2.8%).`
    : `  FAIL — well below the researched +2.8%; the port likely differs from the tested model.`);
}

main();
