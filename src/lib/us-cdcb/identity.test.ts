import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCaReg, parseId17, caRegToId17, caRegToId17Candidates, id17ToCaReg,
  sameRegistration, normalizeNaab, sameNaab, assessLink,
} from "./identity";

// The two worked examples below are the real verified links from Blondin's
// April-2026 file joined against the CDCB April-2026 union.

test("the verified Blondin links transform correctly", () => {
  assert.equal(caRegToId17("HOCANM13486161"), "HOCAN000013486161");   // AIJA BELIEVE-P
  assert.equal(caRegToId17("HO840M3134506807"), "HO840003134506807"); // SIEMERS APPLES ARMY-ET
});

test("the transform round-trips", () => {
  assert.equal(id17ToCaReg("HOCAN000013486161", "M"), "HOCANM13486161");
  assert.equal(id17ToCaReg("HO840003134506807", "M"), "HO840003134506807".slice(0, 5) + "M3134506807");
  // Sex is not encoded in id17, so it must be supplied from the SEX field.
  assert.equal(id17ToCaReg("HOCAN000013486161", "F"), "HOCANF13486161");
});

test("parsing", () => {
  assert.deepEqual(parseCaReg(" hocanm13486161 "), { breed: "HO", country: "CAN", sex: "M", number: "13486161" });
  assert.deepEqual(parseId17("HOCAN000013486161"), { breed: "HO", country: "CAN", number: "000013486161" });
  assert.equal(parseCaReg("NOTAREG"), null);
  assert.equal(parseId17("HOCAN123"), null); // wrong length
});

test("FAILURE MODE 2: Canada is sometimes 124, not CAN — both variants are offered", () => {
  // 13 Progenesis Jerseys sit under JE124... with no JECAN form at all.
  const c = caRegToId17Candidates("JECANM110886150");
  assert.equal(c.length, 2);
  assert.equal(c[0].id17, "JECAN000110886150");
  assert.equal(c[1].id17, "JE124000110886150", "the 124 variant must be tried too");
  assert.ok(c.every((x) => x.confidence === "deterministic"));
});

test("FAILURE MODE 3: USA/840 duality — both variants are offered", () => {
  const c = caRegToId17Candidates("HOUSAM3148929284");
  assert.deepEqual(c.map((x) => x.id17), ["HOUSA003148929284", "HO840003148929284"]);
});

test("FAILURE MODE 1: a herdbook number with letters is a CANDIDATE, never a confident link", () => {
  // Lactanet stores an Australian sire as HOAUSM1993596 while CDCB holds
  // HOAUS0000H01993596 — the leading letters were dropped on our side and cannot
  // be recovered. Padding blindly would point at the wrong animal.
  const c = caRegToId17Candidates("HOAUSM1993596");
  assert.equal(c.length, 1);
  assert.equal(c[0].confidence, "candidate", "an untrusted country must never be deterministic");
  assert.match(c[0].caveat!, /confirm/i);
});

test("an over-long number cannot be padded into 12 characters", () => {
  assert.deepEqual(caRegToId17Candidates("HOCANM1234567890123"), []);
});

test("sameRegistration allows the country variants but nothing looser", () => {
  assert.ok(sameRegistration("HOCANM13486161", "HO124M13486161"));
  assert.ok(sameRegistration("HOUSAM3148929", "HO840M3148929"));
  assert.ok(sameRegistration("HOCANM13486161", "HOCANM013486161"), "leading zeros are not meaningful");
  assert.ok(!sameRegistration("HOCANM13486161", "HOCANF13486161"), "different sex");
  assert.ok(!sameRegistration("HOCANM13486161", "JECANM13486161"), "different breed");
  assert.ok(!sameRegistration("HOCANM13486161", "HOAUSM13486161"), "unrelated countries must not merge");
});

// --- NAAB --------------------------------------------------------------------

test("NAAB normalisation closes the padding gap that loses half a join", () => {
  // CDCB pads (007HO16276); Holstein Association does not (7HO16276). Joining
  // naively matched only 53 of 99 bulls on a real published list.
  assert.equal(normalizeNaab("7HO16276"), "007HO16276");
  assert.equal(normalizeNaab("007HO16276"), "007HO16276");
  assert.equal(normalizeNaab("29JE4716"), "029JE04716");
  assert.equal(normalizeNaab("799HO00030"), "799HO00030");
  assert.ok(sameNaab("7HO16276", "007HO16276"));
  assert.ok(!sameNaab("7HO16276", "7HO16277"));
  assert.equal(normalizeNaab(""), null);
  assert.equal(normalizeNaab(null), null);
});

// --- link assessment ---------------------------------------------------------

test("a deterministic match links on its own", () => {
  const c = caRegToId17Candidates("HOCANM13486161")[0];
  assert.deepEqual(assessLink(c, {}), { linked: true, confidence: "deterministic" });
});

test("a candidate match needs a confirming name or NAAB", () => {
  const c = caRegToId17Candidates("HOAUSM1993596")[0];
  assert.equal(assessLink(c, {}).linked, false, "no confirmation — must not link");
  assert.equal(assessLink(c, { storedName: "Coomboona Zipit", cdcbName: "COOMBOONA ZIPIT" }).linked, true);
  assert.equal(assessLink(c, { storedNaab: "799HO00030", cdcbNaab: "799HO00030" }).linked, true);
});

test("a DISAGREEING NAAB blocks the link even when the id17 matches deterministically", () => {
  // This is the recycled-code hazard: NAAB codes get reused between bulls, and
  // importing through a disagreement would overwrite another animal's identity.
  const c = caRegToId17Candidates("HOCANM13486161")[0];
  const r = assessLink(c, { storedNaab: "799HO00030", cdcbNaab: "250HO12345" });
  assert.equal(r.linked, false);
  assert.match(r.conflict!, /NAAB disagrees/);
});

test("name comparison ignores punctuation and case", () => {
  const c = caRegToId17Candidates("HOAUSM1993596")[0];
  assert.equal(assessLink(c, { storedName: "AIJA BELIEVE-P", cdcbName: "aija believe p" }).linked, true);
});
