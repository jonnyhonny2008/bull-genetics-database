// Unit tests for the relatedness engine. Pure — no DB, no network.
//   C:/Users/Jonathan/nodejs/npx.cmd tsx --test src/lib/relatedness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReg,
  buildCorpus,
  buildAncestorSet,
  ancestorSetFromPAParent,
  pedCompleteness,
  floorForDepth,
  assessRelatedness,
  darkBranchNote,
  NON_IDENTITY_ID_TYPES,
  type PedigreeCorpus,
  type PAParentLike,
} from "./relatedness";

// --- fixtures ---------------------------------------------------------------
// Notes strings are exactly what proof-import.ts writes:
//   `Pedigree (from proof): ` + parts.map(p => `${REL}: ${name ?? "?"}${reg ? ` (${reg})` : ""}`).join(" · ")

const ORDER = ["SIRE", "DAM", "MGS", "MGD", "GMGS", "GMGD"] as const;
type RelKey = (typeof ORDER)[number];

/** Build a real notes line. Values are already `NAME (REG)` / `NAME` fragments. */
const ped = (parts: Partial<Record<RelKey, string>>) =>
  "Pedigree (from proof): " +
  ORDER.filter((k) => parts[k]).map((k) => `${k}: ${parts[k]}`).join(" · ");

interface Fixture { id: string; regs: string[]; notes?: string }

const corpusOf = (rows: Fixture[], opts?: { keepAmbiguous?: boolean }): PedigreeCorpus =>
  buildCorpus(
    rows.flatMap((r) => r.regs.map((idValue) => ({ animalId: r.id, idValue }))),
    rows.filter((r) => r.notes).map((r) => ({ animalId: r.id, notes: r.notes! })),
    opts,
  );

const r4 = (n: number) => Math.round(n * 10000) / 10000;

// One fully literal line, to prove the helper above is not quietly wrong.
const COW1_NOTES =
  "Pedigree (from proof): SIRE: BIG BULL (HOCANM 200000002) · DAM: HER DAM (HOCANM 300000003) · MGS: GRAND SIRE (HOCANM 400000004) · MGD: GRAND DAM (HOCANM 500000005) · GMGS: GREAT SIRE (HOCANM 600000006) · GMGD: GREAT DAM (HOCANM 700000007)";

const COW1: Fixture = { id: "a-cow1", regs: ["HOCANM 111111111"], notes: COW1_NOTES };

/** Her sire, himself an Animal row with his own pedigree line. */
const BIG_BULL: Fixture = {
  id: "a-bigbull",
  regs: ["HOCANM 200000002"],
  notes: ped({
    SIRE: "PGS BULL (HOCANM 210000021)", DAM: "PGD COW (HOCANM 220000022)",
    MGS: "PG MGS (HOCANM 230000023)", MGD: "PG MGD (HOCANM 240000024)",
  }),
};

/** Her MGS, held under BOTH a Canadian registration and a NAAB code. */
const GRAND_SIRE: Fixture = { id: "a-gs", regs: ["HOCANM 400000004", "7HO12345"] };

/** Her GMGS — a real bull in the pool, only reachable at generation 3. */
const BULL_G3: Fixture = {
  id: "a-g3",
  regs: ["HOCANM 600000006"],
  notes: ped({
    SIRE: "G3 SIRE (HOCANM 601000006)", DAM: "G3 DAM (HOCANM 602000006)",
    MGS: "G3 MGS (HOCANM 603000006)", MGD: "G3 MGD (HOCANM 604000006)",
  }),
};

/** Shares GRAND SIRE with her: his sire is her MGS. */
const BULL_COUSIN: Fixture = {
  id: "a-cousin",
  regs: ["HOCANM 800000008"],
  notes: ped({
    SIRE: "GRAND SIRE (HOCANM 400000004)", DAM: "OTHER DAM (HOCANM 900000009)",
    MGS: "OTHER MGS (HOCANM 910000091)", MGD: "OTHER MGD (HOCANM 920000092)",
  }),
};

/** Same shared ancestor, but written down under the NAAB code instead. */
const BULL_NAAB: Fixture = {
  id: "a-naab",
  regs: ["HOCANM 830000083"],
  notes: ped({
    SIRE: "GRAND SIRE (7HO12345)", DAM: "NB DAM (HOCANM 840000084)",
    MGS: "NB MGS (HOCANM 850000085)", MGD: "NB MGD (HOCANM 860000086)",
  }),
};

/** Her son — she is one of HIS ancestors. */
const BULL_SON: Fixture = {
  id: "a-son",
  regs: ["HOCANM 810000081"],
  notes: ped({
    SIRE: "SOME SIRE (HOCANM 820000082)", DAM: "COW ONE (HOCANM 111111111)",
    MGS: "S MGS (HOCANM 870000087)", MGD: "S MGD (HOCANM 880000088)",
  }),
};

/** Unrelated, well documented (his sire resolves) -> 2/4/4. */
const CLEAR_SIRE: Fixture = {
  id: "a-clearsire",
  regs: ["HOCANM 951000095"],
  notes: ped({
    SIRE: "CS S (HOCANM 961000096)", DAM: "CS D (HOCANM 962000096)",
    MGS: "CS MGS (HOCANM 963000096)", MGD: "CS MGD (HOCANM 964000096)",
  }),
};
const BULL_CLEAR: Fixture = {
  id: "a-clear",
  regs: ["HOCANM 950000095"],
  notes: ped({
    SIRE: "CLEAR SIRE (HOCANM 951000095)", DAM: "CLEAR DAM (HOCANM 952000095)",
    MGS: "CLEAR MGS (HOCANM 953000095)", MGD: "CLEAR MGD (HOCANM 954000095)",
    GMGS: "CLEAR GMGS (HOCANM 955000095)", GMGD: "CLEAR GMGD (HOCANM 956000095)",
  }),
};

/** Unrelated, but paternally blind — own notes only -> 2/2/2. */
const BULL_THIN: Fixture = {
  id: "a-thin",
  regs: ["HOCANM 970000097"],
  notes: ped({
    SIRE: "THIN SIRE (HOCANM 971000097)", DAM: "THIN DAM (HOCANM 972000097)",
    MGS: "THIN MGS (HOCANM 973000097)", MGD: "THIN MGD (HOCANM 974000097)",
    GMGS: "THIN GMGS (HOCANM 975000097)", GMGD: "THIN GMGD (HOCANM 976000097)",
  }),
};

/** In the database, but we hold no pedigree line for him at all. */
const BULL_NOBODY: Fixture = { id: "a-nobody", regs: ["HOCANM 990000099"] };

const ALL: Fixture[] = [
  COW1, BIG_BULL, GRAND_SIRE, BULL_G3, BULL_COUSIN, BULL_NAAB, BULL_SON,
  CLEAR_SIRE, BULL_CLEAR, BULL_THIN, BULL_NOBODY,
];
const corpus = corpusOf(ALL);

const paAnc = (generation: number, side: "sire" | "dam", reg: string | null, name: string | null) =>
  ({ generation, side, reg, name });

/** A live-fetched cow with a complete 14-slot family tree (no DB row of her own). */
const paCow: PAParentLike = {
  reg: "HOCANM 999000999",
  name: "LIVE COW",
  animalId: null,
  ancestors: [
    paAnc(1, "sire", "HOCANM 101000001", "PA SIRE"),
    paAnc(1, "dam", "HOCANM 101000002", "PA DAM"),
    // generation 2 — one of them is GRAND SIRE, written as his NAAB code.
    paAnc(2, "sire", "7HO12345", "GRAND SIRE"),
    paAnc(2, "sire", "HOCANM 102000002", "PA PGD"),
    paAnc(2, "dam", "HOCANM 102000003", "PA MGS"),
    paAnc(2, "dam", "HOCANM 102000004", "PA MGD"),
    paAnc(3, "sire", "HOCANM 103000001", "G3 A"),
    paAnc(3, "sire", "HOCANM 103000002", "G3 B"),
    paAnc(3, "sire", "HOCANM 103000003", "G3 C"),
    paAnc(3, "sire", "HOCANM 103000004", "G3 D"),
    paAnc(3, "dam", "HOCANM 103000005", "G3 E"),
    paAnc(3, "dam", "HOCANM 103000006", "G3 F"),
    paAnc(3, "dam", "HOCANM 103000007", "G3 G"),
    paAnc(3, "dam", "HOCANM 103000008", "G3 H"),
  ],
};

const D3 = { maxGen: 3 as const, floor: 0.75 };
const D2 = { maxGen: 2 as const, floor: 0.75 };

const cow = () => buildAncestorSet(COW1.id, corpus, 3);

// --- normalizeReg -----------------------------------------------------------

test("normalizeReg: the required vectors", () => {
  assert.equal(normalizeReg("HOCANM 13486161"), "HOCANM13486161");
  assert.equal(normalizeReg("HO840M0000111"), "HO840M111");
  assert.equal(normalizeReg("hocanm000012345"), "HOCANM12345");
  assert.equal(normalizeReg("7HO12345"), "7HO12345");
  assert.equal(normalizeReg(""), null);
  assert.equal(normalizeReg(null), null);
  assert.equal(normalizeReg("—"), null);
});

test("normalizeReg never strips the breed/country prefix", () => {
  // Two different registries, same serial: these must NOT collapse together.
  assert.notEqual(normalizeReg("HOCANM 12345"), normalizeReg("HOUSAM 12345"));
  // Only the FINAL numeric run loses its leading zeros; "840" survives.
  assert.equal(normalizeReg("HO 840M 000 0111"), "HO840M111");
  assert.equal(normalizeReg(undefined), null);
});

// --- the ancestor walk ------------------------------------------------------

test("own notes give six ancestors at 1/1/2/2/3/3", () => {
  const thin = corpusOf([COW1]); // none of her ancestors are Animal rows
  const s = buildAncestorSet(COW1.id, thin, 3);
  assert.equal(s.keys.get("HOCANM200000002"), 1); // sire
  assert.equal(s.keys.get("HOCANM300000003"), 1); // dam
  assert.equal(s.keys.get("HOCANM400000004"), 2); // MGS
  assert.equal(s.keys.get("HOCANM500000005"), 2); // MGD
  assert.equal(s.keys.get("HOCANM600000006"), 3); // GMGS
  assert.equal(s.keys.get("HOCANM700000007"), 3); // GMGD
  assert.deepEqual([s.n1, s.n2, s.n3], [2, 2, 2]);
  assert.equal(s.selfKeys.has("HOCANM111111111"), true);
});

test("the sire's own parents are only reachable by recursing into HIS notes", () => {
  const thin = buildAncestorSet(COW1.id, corpusOf([COW1]), 3);
  assert.equal(thin.keys.has("HOCANM210000021"), false, "PGS unreachable without the sire's row");

  const deep = cow(); // full corpus: BIG BULL is an Animal row with notes
  assert.equal(deep.keys.get("HOCANM210000021"), 2, "sire's sire is the cow's generation 2");
  assert.equal(deep.keys.get("HOCANM220000022"), 2, "sire's dam is the cow's generation 2");
  assert.equal(deep.keys.get("HOCANM230000023"), 3, "sire's MGS is the cow's generation 3");
  assert.deepEqual([deep.n1, deep.n2, deep.n3], [2, 4, 4]);
});

test("alias expansion puts every active identifier of a resolved ancestor in the set", () => {
  const s = cow();
  // Her MGS was written down as HOCANM 400000004; he is also 7HO12345.
  assert.equal(s.keys.get("HOCANM400000004"), 2);
  assert.equal(s.keys.get("7HO12345"), 2, "the NAAB alias must be a comparison key too");
  // Both aliases point at ONE entity, so he is counted once.
  assert.equal(s.entityByKey.get("7HO12345"), s.entityByKey.get("HOCANM400000004"));
  assert.equal(s.n2, 4, "the alias must not inflate the generation-2 count");
});

// --- pedigree completeness --------------------------------------------------

test("pedCompleteness: 2/2/2 -> 0.583, 2/4/4 -> 0.833, 2/4/8 -> 1.000", () => {
  const blind = buildAncestorSet(COW1.id, corpusOf([COW1]), 3); // sire unresolved
  assert.deepEqual([blind.n1, blind.n2, blind.n3], [2, 2, 2]);
  assert.equal(r4(pedCompleteness(blind)), 0.5833);

  const deep = cow(); // sire resolves
  assert.deepEqual([deep.n1, deep.n2, deep.n3], [2, 4, 4]);
  assert.equal(r4(pedCompleteness(deep)), 0.8333);

  const full = ancestorSetFromPAParent(paCow, corpus, 3); // 14 live-fetched slots
  assert.deepEqual([full.n1, full.n2, full.n3], [2, 4, 8]);
  assert.equal(pedCompleteness(full), 1);
  assert.equal(full.slots, 14);
});

test("an ancestor with a name but no registration number does not inflate completeness", () => {
  const withReg: Fixture = { id: "a-x", regs: ["HOCANM 121212121"], notes: COW1_NOTES };
  const namedOnly: Fixture = {
    id: "a-x",
    regs: ["HOCANM 121212121"],
    // MGD is named but carries no (REG) — the importer writes it exactly like this.
    notes: ped({
      SIRE: "BIG BULL (HOCANM 200000002)", DAM: "HER DAM (HOCANM 300000003)",
      MGS: "GRAND SIRE (HOCANM 400000004)", MGD: "NAMELESS DAM",
      GMGS: "GREAT SIRE (HOCANM 600000006)", GMGD: "GREAT DAM (HOCANM 700000007)",
    }),
  };
  const a = buildAncestorSet("a-x", corpusOf([withReg]), 3);
  const b = buildAncestorSet("a-x", corpusOf([namedOnly]), 3);

  assert.deepEqual([a.n1, a.n2, a.n3], [2, 2, 2]);
  assert.deepEqual([b.n1, b.n2, b.n3], [2, 1, 2], "the nameless MGD is an EMPTY slot");
  assert.equal(r4(pedCompleteness(a)), 0.5833);
  assert.equal(r4(pedCompleteness(b)), 0.5, "a name we cannot compare must lower confidence");
  assert.equal(b.nameOnly, 1);
  assert.match(darkBranchNote(b) ?? "", /without a registration number/);
});

// --- the four predicate cases ----------------------------------------------

test("case 1 — a common ancestor: her MGS is his sire", () => {
  const v = assessRelatedness(cow(), buildAncestorSet(BULL_COUSIN.id, corpus, 3), D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.shared.length, 1, "one entity, not one per alias");
  assert.equal(v.shared[0].reg, "HOCANM400000004");
  assert.equal(v.shared[0].name, "GRAND SIRE");
  assert.equal(v.shared[0].cowGen, 2);
  assert.equal(v.shared[0].bullGen, 1);
  assert.equal(v.shared[0].label, "her MGS × his sire");
  assert.equal(v.closestSum, 3);
});

test("case 2 — THE BULL IS HER SIRE (an ancestors-only test would miss this)", () => {
  const c = cow();
  const sire = buildAncestorSet(BIG_BULL.id, corpus, 3);
  // His own registration is nowhere in his own ancestor set — that is exactly
  // why the predicate has to union Self() onto both sides.
  assert.equal(sire.keys.has("HOCANM200000002"), false);
  assert.equal(sire.selfKeys.has("HOCANM200000002"), true);

  const v = assessRelatedness(c, sire, D3);
  assert.equal(v.tier, "excluded", "the report must never recommend a cow's own father");
  assert.equal(v.shared[0].cowGen, 1);
  assert.equal(v.shared[0].bullGen, 0);
  assert.equal(v.shared[0].label, "this bull is her sire");
  assert.equal(v.closestSum, 1);
});

test("case 2b — grandsire × granddaughter", () => {
  const v = assessRelatedness(cow(), buildAncestorSet(GRAND_SIRE.id, corpus, 3), D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.shared[0].cowGen, 2);
  assert.equal(v.shared[0].bullGen, 0);
  assert.equal(v.shared[0].label, "this bull is her MGS");
  assert.equal(v.closestSum, 2);
});

test("case 3 — she is one of his ancestors", () => {
  const v = assessRelatedness(cow(), buildAncestorSet(BULL_SON.id, corpus, 3), D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.shared[0].cowGen, 0);
  assert.equal(v.shared[0].bullGen, 1);
  assert.equal(v.shared[0].label, "she is his dam");
  assert.equal(v.closestSum, 1);
});

test("case 4 — the same animal on both sides", () => {
  const c = cow();
  const v = assessRelatedness(c, c, D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.closestSum, 0, "closestSum 0 is the caller's signal to drop the row");
  assert.equal(v.shared[0].label, "she is this bull");
});

// --- alias expansion is load-bearing ---------------------------------------

test("the same shared bull under a Canadian reg and a NAAB code still matches", () => {
  // She names her MGS "HOCANM 400000004"; this bull's sire is written "7HO12345".
  // The two strings share nothing — only alias expansion links them.
  const withAlias = assessRelatedness(cow(), buildAncestorSet(BULL_NAAB.id, corpus, 3), D3);
  assert.equal(withAlias.tier, "excluded");
  assert.equal(withAlias.shared[0].label, "her MGS × his sire");

  // Control: drop GRAND SIRE's Animal row so neither reg resolves. The strings
  // no longer meet, and the shared ancestor becomes invisible.
  const noAlias = corpusOf(ALL.filter((f) => f.id !== GRAND_SIRE.id));
  const blind = assessRelatedness(
    buildAncestorSet(COW1.id, noAlias, 3),
    buildAncestorSet(BULL_NAAB.id, noAlias, 3),
    D3,
  );
  assert.equal(blind.shared.length, 0);
  assert.notEqual(blind.tier, "excluded");
});

// --- tiers and confidence ---------------------------------------------------

test("clear: no shared key and both sides documented past the floor", () => {
  const v = assessRelatedness(cow(), buildAncestorSet(BULL_CLEAR.id, corpus, 3), D3);
  assert.equal(v.shared.length, 0);
  assert.equal(r4(v.confidence), 0.8333);
  assert.equal(v.tier, "clear");
  assert.equal(v.closestSum, null);
});

test("pair confidence is the MINIMUM — never a product, never a mean", () => {
  const c = cow();                                              // 0.8333
  const thin = buildAncestorSet(BULL_THIN.id, corpus, 3);       // 0.5833
  assert.equal(r4(pedCompleteness(c)), 0.8333);
  assert.equal(r4(pedCompleteness(thin)), 0.5833);

  const v = assessRelatedness(c, thin, D3);
  const a = pedCompleteness(c), b = pedCompleteness(thin);
  assert.equal(v.confidence, Math.min(a, b));
  assert.notEqual(r4(v.confidence), r4(a * b), "a product would read 0.486");
  assert.notEqual(r4(v.confidence), r4((a + b) / 2), "a mean would read 0.708 and clear the floor");
  // The blinder half decides: a paternally blind bull is NOT recommendable.
  assert.equal(v.tier, "unknown");
  assert.match(darkBranchNote(thin) ?? "", /paternal generation 2 not screened/);
});

test("no-pedigree when either side has no keys at all", () => {
  const nobody = buildAncestorSet(BULL_NOBODY.id, corpus, 3);
  assert.equal(nobody.keys.size, 0);
  assert.equal(nobody.slots, 0);
  assert.equal(nobody.pedComplete, 0);

  const v = assessRelatedness(cow(), nobody, D3);
  assert.equal(v.tier, "no-pedigree");
  assert.equal(v.shared.length, 0);
  assert.equal(v.confidence, 0);
  assert.match(darkBranchNote(nobody) ?? "", /no pedigree on record/);

  // Mirrored: a degraded female against a fully documented bull.
  const other = buildAncestorSet("a-other-nobody", corpusOf([{ id: "a-other-nobody", regs: ["HOCANM 991000099"] }]), 3);
  const both = assessRelatedness(other, nobody, D3);
  assert.equal(both.tier, "no-pedigree");

  // But two keyless sets that are the SAME animal are case 4, not ignorance.
  assert.equal(assessRelatedness(nobody, nobody, D3).tier, "excluded");
  assert.equal(assessRelatedness(nobody, nobody, D3).closestSum, 0);
});

test("a bull with no pedigree who IS her sire is still excluded, not 'no-pedigree'", () => {
  // Exclusion outranks ignorance: Self(bull) ∩ A(cow) fires even with zero keys.
  const sireless = corpusOf(ALL.map((f) => (f.id === BIG_BULL.id ? { ...f, notes: undefined } : f)));
  const bull = buildAncestorSet(BIG_BULL.id, sireless, 3);
  assert.equal(bull.keys.size, 0);
  const v = assessRelatedness(buildAncestorSet(COW1.id, sireless, 3), bull, D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.closestSum, 1);
});

// --- depth ------------------------------------------------------------------

test("maxGen 2 vs 3 changes the verdict for a generation-3 relative", () => {
  const bull3 = buildAncestorSet(BULL_G3.id, corpus, 3); // he IS her GMGS
  const at3 = assessRelatedness(cow(), bull3, D3);
  assert.equal(at3.tier, "excluded");
  assert.equal(at3.shared[0].cowGen, 3);
  assert.equal(at3.shared[0].bullGen, 0);
  assert.equal(at3.closestSum, 3);

  // At depth 2 the third generation is simply not looked at, so no shared
  // ancestor is found — the honest answer to a question that was never asked.
  // The pair is still NOT certified: this bull's own pedigree is 2/2, i.e. his
  // sire's parents are unrecorded, and those are generation-2 ancestors — the
  // very generation a depth-2 screen exists to check.
  const bull2 = buildAncestorSet(BULL_G3.id, corpus, 2);
  const at2 = assessRelatedness(buildAncestorSet(COW1.id, corpus, 2), bull2, D2);
  assert.equal(at2.shared.length, 0);
  assert.equal(at2.confidence, 0.75, "his 2/2 pedigree is the blinder half");
  assert.equal(at2.tier, "unknown", "a shallower screen must not certify a thinner pedigree");
});

test("maxGen 2 never walks past generation 2", () => {
  const s = buildAncestorSet(COW1.id, corpus, 2);
  assert.equal(s.n3, 0);
  assert.equal(s.keys.has("HOCANM600000006"), false);
  assert.equal(Math.max(...s.keys.values()), 2);
  assert.equal(s.slots, 6); // 2 parents + 4 grandparents
});

// --- ancestorSetFromPAParent ------------------------------------------------

test("ancestorSetFromPAParent maps the tree without recursing, and still expands aliases", () => {
  const s = ancestorSetFromPAParent(paCow, corpus, 3);
  assert.equal(s.selfKeys.has("HOCANM999000999"), true);
  assert.equal(s.keys.get("HOCANM101000001"), 1);
  assert.equal(s.keys.get("7HO12345"), 2);
  assert.equal(s.keys.get("HOCANM400000004"), 2, "alias of the same bull, added by expansion");
  assert.equal(s.n2, 4, "the alias is one ancestor, not two");
  // No recursion: BIG BULL's row is in the corpus but nothing was pulled from it.
  assert.equal(s.keys.has("HOCANM210000021"), false);

  const v = assessRelatedness(s, buildAncestorSet(BULL_COUSIN.id, corpus, 3), D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.shared[0].label, "her sire's parent × his sire");
  assert.equal(v.closestSum, 3);
});

test("ancestorSetFromPAParent: a live parent with an unreadable pedigree fails closed", () => {
  const broken: PAParentLike = { reg: "HOCANM 888000888", name: "NO TREE", animalId: null, ancestors: [] };
  const s = ancestorSetFromPAParent(broken, corpus, 3);
  assert.equal(s.keys.size, 0);
  assert.equal(s.slots, 0, "slots < 4 — the caller must produce zero recommendations");
  assert.equal(s.pedComplete, 0);
  assert.equal(assessRelatedness(s, buildAncestorSet(BULL_CLEAR.id, corpus, 3), D3).tier, "no-pedigree");
});

test("ancestorSetFromPAParent ignores ancestors past the requested depth and self-references", () => {
  const odd: PAParentLike = {
    reg: "HOCANM 777000777",
    name: "ODD",
    animalId: null,
    ancestors: [
      paAnc(1, "sire", "HOCANM 105000001", "S"),
      paAnc(1, "dam", "HOCANM 105000002", "D"),
      paAnc(4, "sire", "HOCANM 105000003", "TOO DEEP"),
      paAnc(2, "dam", null, "NAMED BUT UNREGISTERED"),
      paAnc(2, "sire", "HOCANM 777000777", "HERSELF — bad data"),
    ],
  };
  const s = ancestorSetFromPAParent(odd, corpus, 3);
  assert.equal(s.keys.has("HOCANM105000003"), false, "generation 4 is out of scope");
  assert.equal(s.keys.has("HOCANM777000777"), false, "an animal is not its own ancestor");
  assert.deepEqual([s.n1, s.n2, s.n3], [2, 0, 0]);
  assert.equal(s.nameOnly, 1);
  assert.equal(s.slots, 2);
});

// --- degenerate corpora -----------------------------------------------------

test("empty corpus: everything is no-pedigree, nothing throws", () => {
  const empty = buildCorpus([], []);
  const s = buildAncestorSet("ghost", empty, 3);
  assert.equal(s.keys.size, 0);
  assert.equal(s.selfKeys.size, 0);
  // We still know WHO the subject is, but with no identifiers there is nothing
  // to compare, so self can never produce a hit.
  assert.equal(s.selfEntity, "ghost");
  assert.equal(pedCompleteness(s), 0);
  const v = assessRelatedness(s, s, D3);
  assert.equal(v.tier, "no-pedigree");
  assert.equal(v.confidence, 0);
  assert.equal(v.closestSum, null);
});

test("buildCorpus keeps the richest pedigree line and skips unusable ones", () => {
  const c = buildCorpus(
    [{ animalId: "a", idValue: "HOCANM 1" }, { animalId: "a", idValue: null }],
    [
      { animalId: "a", notes: null },
      { animalId: "a", notes: "Pedigree (from proof): SIRE: ONLY A NAME" }, // no regs -> unusable
      { animalId: "a", notes: ped({ SIRE: "S (HOCANM 2)", DAM: "D (HOCANM 3)" }) },
      { animalId: "a", notes: ped({ SIRE: "S (HOCANM 2)" }) },
    ],
  );
  assert.equal(c.regsByAnimalId.get("a")?.length, 1);
  assert.equal(c.regToAnimalId.get("HOCANM1"), "a");
  const s = buildAncestorSet("a", c, 3);
  assert.deepEqual([s.n1, s.n2, s.n3], [2, 0, 0]);
});

// --- identifier hygiene: a key held by two animals names neither -------------
// Regression: loadPedigreeCorpus fed the raw active-identifier table straight
// into buildCorpus. A registration held by two Animal rows (duplicate import)
// resolved first-wins to the WRONG row, and the walk then read a stranger's
// pedigree as the cow's paternal line.

/** Two Animal rows both claim HOCANM 3000003. The decoy is indexed FIRST. */
const DUP_DECOY: Fixture = {
  id: "a-decoy",
  regs: ["HOCANM 3000003", "HOCANM 3900009"],
  notes: ped({ SIRE: "STRANGER (HOCANM 6666666)", DAM: "STRANGER DAM (HOCANM 6666667)" }),
};
const DUP_REAL_SIRE: Fixture = {
  id: "a-realsire",
  regs: ["HOCANM 3000003"],
  notes: ped({ SIRE: "TRUE PGS (HOCANM 5555555)", DAM: "TRUE PGD (HOCANM 5555556)" }),
};
const DUP_COW: Fixture = {
  id: "a-dupcow",
  regs: ["HOCANM 13000001"],
  notes: ped({
    SIRE: "SIRE-A (HOCANM 3000003)", DAM: "DAM-A (HOCANM 3000004)",
    MGS: "DUP MGS (HOCANM 3000005)", MGD: "DUP MGD (HOCANM 3000006)",
  }),
};
const DUP_STRANGER: Fixture = { id: "a-stranger", regs: ["HOCANM 6666666"] };
const DUP_PGS: Fixture = { id: "a-truepgs", regs: ["HOCANM 5555555"] };
const DUP_ROWS = [DUP_DECOY, DUP_REAL_SIRE, DUP_COW, DUP_STRANGER, DUP_PGS];

test("an ambiguous registration is never resolved and never walked into", () => {
  const c = corpusOf(DUP_ROWS);
  assert.equal(c.ambiguousKeys.has("HOCANM3000003"), true);
  assert.equal(c.regToAnimalId.has("HOCANM3000003"), false, "it names two animals, so it names neither");

  const cow = buildAncestorSet(DUP_COW.id, c, 3);
  assert.equal(cow.keys.get("HOCANM3000003"), 1, "the string she wrote is still a comparison key");
  assert.equal(cow.keys.has("HOCANM6666666"), false, "the DECOY's sire must not become her grandsire");
  assert.equal(cow.keys.has("HOCANM5555555"), false, "no recursion at all through an ambiguous key");
  // Fail closed rather than certify: with no route into the sire's row her
  // paternal generations 2-3 are unknown, so she scores the blind 0.583.
  assert.deepEqual([cow.n1, cow.n2, cow.n3], [2, 2, 0]);
  assert.equal(pedCompleteness(cow), 0.5, "well under the 0.75 floor");
  assert.equal(
    assessRelatedness(cow, buildAncestorSet(BULL_CLEAR.id, corpus, 3), D3).tier,
    "unknown",
    "an unreadable paternal line is withheld, not cleared",
  );

  // A stranger picked up only by walking the wrong row is NOT related to her.
  const strangerV = assessRelatedness(cow, buildAncestorSet(DUP_STRANGER.id, c, 3), D3);
  assert.equal(strangerV.shared.length, 0);
  assert.notEqual(strangerV.tier, "excluded");
});

test("an ambiguous registration STILL identifies its owners — her sire is caught", () => {
  // The other half of the rule. Dropping the key from the owners' identity (what
  // the sibling loaders did) would delete the bull's own registration from his
  // selfKeys, and "this bull is her sire" — the single most important exclusion
  // in the feature — would stop firing on exactly the duplicate-imported rows.
  const c = corpusOf(DUP_ROWS);
  const cow = buildAncestorSet(DUP_COW.id, c, 3);

  const real = buildAncestorSet(DUP_REAL_SIRE.id, c, 3);
  assert.equal(real.selfKeys.has("HOCANM3000003"), true, "he still claims his own registration");
  const v = assessRelatedness(cow, real, D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.shared[0].label, "this bull is her sire");
  assert.equal(v.closestSum, 1);

  // The duplicate row claims the same registration, so it is excluded too.
  // Over-exclusion on a row that claims to BE her sire is the safe direction.
  assert.equal(assessRelatedness(cow, buildAncestorSet(DUP_DECOY.id, c, 3), D3).tier, "excluded");
});

test("control: keeping ambiguous keys walks the wrong row and invents a relative", () => {
  // What the unhygienic corpus did, kept as the proof that the fix is load-bearing.
  const raw = corpusOf(DUP_ROWS, { keepAmbiguous: true });
  assert.equal(raw.regToAnimalId.get("HOCANM3000003"), DUP_DECOY.id, "first row wins");
  const cow = buildAncestorSet(DUP_COW.id, raw, 3);
  assert.equal(cow.keys.get("HOCANM6666666"), 2, "a stranger, read in as her paternal grandsire");
  assert.equal(
    assessRelatedness(cow, buildAncestorSet(DUP_STRANGER.id, raw, 3), D3).tier,
    "excluded",
    "…and excluded on the strength of a pedigree that is not hers",
  );
});

// --- identifier hygiene: the marketing-code blob -----------------------------
// Production carries an active marketing_code "0799" on ~160 different bulls.
// Alias-expanded it lands in one cow's ancestor keys and in every one of those
// bulls' selfKeys, excluding all of them with a fabricated "this bull is her
// sire" naming her real sire's registration.

const BLOB_HOUSE: Fixture = {
  id: "a-house",
  regs: ["HOCANM 4000001", "0799"],
  notes: ped({ SIRE: "HOUSE SIRE (HOCANM 4100001)", DAM: "HOUSE DAM (HOCANM 4100002)" }),
};
const BLOB_A: Fixture = { id: "a-blob-a", regs: ["HOCANM 4200001", "0799"] };
const BLOB_B: Fixture = { id: "a-blob-b", regs: ["HOCANM 4200002", "0799"] };
const BLOB_COW: Fixture = {
  id: "a-blobcow",
  regs: ["HOCANM 14000001"],
  notes: ped({
    SIRE: "HOUSE BULL (HOCANM 4000001)", DAM: "BLOB DAM (HOCANM 4300001)",
    MGS: "BLOB MGS (HOCANM 4300002)", MGD: "BLOB MGD (HOCANM 4300003)",
  }),
};
const BLOB_ROWS = [BLOB_HOUSE, BLOB_A, BLOB_B, BLOB_COW];

test("a shared marketing code is never alias-expanded into an ancestor set", () => {
  const c = corpusOf(BLOB_ROWS);
  assert.equal(normalizeReg("0799"), "799");
  assert.equal(c.ambiguousKeys.has("799"), true);
  assert.equal(c.aliasRegsByAnimalId.get(BLOB_HOUSE.id)?.includes("799"), false, "not expandable");
  assert.equal(c.regsByAnimalId.get(BLOB_HOUSE.id)?.includes("799"), true, "still his own identity");

  const cow = buildAncestorSet(BLOB_COW.id, c, 3);
  assert.equal(cow.keys.get("HOCANM4000001"), 1, "her real sire, by his real registration");
  assert.equal(cow.keys.has("799"), false, "the code must not ride in on the expansion");

  // Her actual sire is still caught…
  assert.equal(assessRelatedness(cow, buildAncestorSet(BLOB_HOUSE.id, c, 3), D3).tier, "excluded");
  // …and the unrelated bulls that merely share the marketing code are not.
  for (const blob of [BLOB_A, BLOB_B]) {
    const v = assessRelatedness(cow, buildAncestorSet(blob.id, c, 3), D3);
    assert.equal(v.shared.length, 0, `${blob.id} has no connection to her`);
    assert.notEqual(v.tier, "excluded");
  }
});

test("control: expanding the shared code excludes every bull that carries it", () => {
  const raw = corpusOf(BLOB_ROWS, { keepAmbiguous: true });
  const cow = buildAncestorSet(BLOB_COW.id, raw, 3);
  assert.equal(cow.keys.get("799"), 1, "expanded off her sire, at his generation");
  const v = assessRelatedness(cow, buildAncestorSet(BLOB_A.id, raw, 3), D3);
  assert.equal(v.tier, "excluded");
  assert.equal(v.shared[0].label, "this bull is her sire", "a fabricated claim about a stranger");
});

test("product and barn-label identifier types are kept out of the corpus query", () => {
  // The keys that collide across unrelated animals in the first place. No
  // pedigree line ever names an ancestor by one, so they can only invent.
  for (const t of ["marketing_code", "semen_code", "ear_tag", "tattoo"]) {
    assert.ok(NON_IDENTITY_ID_TYPES.includes(t), `${t} must not be a comparison key`);
  }
});

// --- depth must not be an evidence relaxer ----------------------------------
// Regression: completenessAt() normalises over the depth screened, which
// multiplies every score by 3/d. Left alone, the paternally blind cohort scored
// 0.583 (withheld) at depth 3 and 0.750 (CLEAR) at depth 2 on identical data.

test("floorForDepth undoes the depth renormalisation", () => {
  assert.equal(floorForDepth(0.75, 3), 0.75);
  assert.equal(floorForDepth(0.75, 2), 1, "0.75 x 3/2 = 1.125, capped at 1");
  assert.equal(floorForDepth(0.5, 2), 0.75);
});

test("a shallower screen never upgrades a withheld pair to a recommendation", () => {
  // Both sides own-notes-only, neither sire a held Animal row: their shared
  // paternal grandsire, if any, is written on neither line and is unscreenable.
  const thinCow: Fixture = {
    id: "a-thincow",
    regs: ["HOCANM 15000001"],
    notes: ped({
      SIRE: "TC SIRE (HOCANM 15100001)", DAM: "TC DAM (HOCANM 15100002)",
      MGS: "TC MGS (HOCANM 15100003)", MGD: "TC MGD (HOCANM 15100004)",
    }),
  };
  const c = corpusOf([thinCow, BULL_THIN]);

  const at3 = assessRelatedness(
    buildAncestorSet(thinCow.id, c, 3),
    buildAncestorSet(BULL_THIN.id, c, 3),
    D3,
  );
  assert.equal(at3.tier, "unknown", "paternally blind on both sides — correctly withheld");

  const cow2 = buildAncestorSet(thinCow.id, c, 2);
  const bull2 = buildAncestorSet(BULL_THIN.id, c, 2);
  assert.deepEqual([cow2.n1, cow2.n2], [2, 2], "blind to BOTH paternal grandparents");
  assert.equal(pedCompleteness(cow2), 0.75, "the renormalised score still reads 0.75…");
  const at2 = assessRelatedness(cow2, bull2, D2);
  assert.equal(at2.confidence, 0.75);
  assert.equal(at2.tier, "unknown", "…but the floor scaled with it, so the pair stays withheld");
});

test("a genuinely complete two-generation pedigree still clears at depth 2", () => {
  // Depth 2 must remain usable: both animals' sires are held rows, so all four
  // grandparents are known and generation 2 — the whole subject of the screen —
  // is fully read on both sides.
  const cow2 = buildAncestorSet(COW1.id, corpus, 2);
  const bull2 = buildAncestorSet(BULL_CLEAR.id, corpus, 2);
  assert.deepEqual([cow2.n1, cow2.n2], [2, 4]);
  assert.deepEqual([bull2.n1, bull2.n2], [2, 4]);
  const v = assessRelatedness(cow2, bull2, D2);
  assert.equal(v.confidence, 1);
  assert.equal(v.tier, "clear");
});

test("a pedigree cycle cannot hang the walk", () => {
  // Corrupt data: two bulls each recorded as the other's sire.
  const cyc = corpusOf([
    { id: "x", regs: ["HOCANM 1"], notes: ped({ SIRE: "Y (HOCANM 2)", DAM: "DX (HOCANM 3)" }) },
    { id: "y", regs: ["HOCANM 2"], notes: ped({ SIRE: "X (HOCANM 1)", DAM: "DY (HOCANM 4)" }) },
  ]);
  const s = buildAncestorSet("x", cyc, 3);
  assert.equal(s.keys.get("HOCANM2"), 1);
  assert.equal(s.keys.has("HOCANM1"), false, "the subject is never its own ancestor");
  assert.deepEqual([s.n1, s.n2, s.n3], [2, 1, 0]);
});
