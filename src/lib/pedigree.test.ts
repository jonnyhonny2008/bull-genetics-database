import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePedigreeNotes, pedigreeNotesFromFamilyTree } from "./pedigree";

/** A scraped family tree in the shape Lactanet profiles arrive in. */
const TREE = [
  { generation: 1, side: "sire", name: "MORNINGVIEW MCC KINGBOY-ET", reg: "HOUSAM72044077" },
  { generation: 2, side: "sire", name: "DE-SU BKM MCCUTCHEN 1174-ET", reg: "HOUSAM69990138" },
  { generation: 2, side: "sire", name: "MORNINGVIEW SUPER MEGAN-ET", reg: "HOUSAF68654508" },
  { generation: 1, side: "dam", name: "STANTONS MCCUTCHEN 1174 AGREE", reg: "HOCANF11696367" },
  { generation: 2, side: "dam", name: "DE-SU BKM MCCUTCHEN 1174-ET", reg: "HOUSAM69990138" },
  { generation: 2, side: "dam", name: "STANTONS OBSERVER EXTREME", reg: "HOCANF11230598" },
];

/**
 * The whole point of the helper: what it writes must survive being read back by
 * the parser the relatedness engine uses. These two live in the same file
 * precisely so they cannot drift apart.
 */
test("a converted family tree round-trips through the parser", () => {
  const notes = pedigreeNotesFromFamilyTree(TREE);
  assert.ok(notes, "expected a pedigree line");
  const parsed = parsePedigreeNotes(notes);
  const byRel = new Map(parsed.map((p) => [p.relation, p]));

  assert.equal(byRel.get("sire")?.reg, "HOUSAM72044077");
  assert.equal(byRel.get("dam")?.reg, "HOCANF11696367");
  // Generation 2 on the DAM side is the maternal grandparents; the male one is
  // the MGS regardless of the order the scrape happened to return them in.
  assert.equal(byRel.get("mgs")?.reg, "HOUSAM69990138");
  assert.equal(byRel.get("mgd")?.reg, "HOCANF11230598");
  assert.equal(byRel.get("mgs")?.name, "DE-SU BKM MCCUTCHEN 1174-ET");
});

test("maternal grandparents are picked by sex, not by position", () => {
  // Same pair, reversed. A position-based reading would swap MGS and MGD.
  const reversed = [
    { generation: 1, side: "sire", name: "S", reg: "HOCANM100000001" },
    { generation: 1, side: "dam", name: "D", reg: "HOCANF100000002" },
    { generation: 2, side: "dam", name: "HER DAM", reg: "HOCANF100000004" },
    { generation: 2, side: "dam", name: "HER SIRE", reg: "HOCANM100000003" },
  ];
  const byRel = new Map(parsePedigreeNotes(pedigreeNotesFromFamilyTree(reversed)).map((p) => [p.relation, p]));
  assert.equal(byRel.get("mgs")?.reg, "HOCANM100000003");
  assert.equal(byRel.get("mgd")?.reg, "HOCANF100000004");
});

test("paternal generation 2 is not emitted — it has no slot in this format", () => {
  // The sire's own parents are reached by recursing into the sire's record.
  // Emitting them here would silently mislabel them as maternal.
  const notes = pedigreeNotesFromFamilyTree(TREE)!;
  assert.ok(!notes.includes("HOUSAF68654508"), "the sire's dam must not appear as a maternal ancestor");
});

test("a tree with only a sire still yields a usable line", () => {
  const notes = pedigreeNotesFromFamilyTree([
    { generation: 1, side: "sire", name: "LONE SIRE", reg: "HOCANM100000009" },
  ]);
  const parsed = parsePedigreeNotes(notes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].relation, "sire");
});

test("an empty or ancestor-less tree yields nothing rather than an empty label", () => {
  assert.equal(pedigreeNotesFromFamilyTree([]), null);
  assert.equal(pedigreeNotesFromFamilyTree([{ generation: 3, side: "sire", name: "TOO DEEP", reg: "HOCANM1" }]), null);
});

test("a missing name is written as the parser's placeholder", () => {
  const notes = pedigreeNotesFromFamilyTree([
    { generation: 1, side: "sire", name: null, reg: "HOCANM100000010" },
  ])!;
  assert.ok(notes.includes("SIRE: ? (HOCANM100000010)"), notes);
  // "?" is the placeholder, and the parser turns it back into a null name.
  assert.equal(parsePedigreeNotes(notes)[0].name, null);
});

test("the label is carried through so the source stays visible", () => {
  const notes = pedigreeNotesFromFamilyTree(TREE, "Pedigree (from proof)")!;
  assert.ok(notes.startsWith("Pedigree (from proof): SIRE:"), notes.slice(0, 40));
});
