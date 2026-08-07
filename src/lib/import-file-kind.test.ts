import { test } from "node:test";
import assert from "node:assert/strict";
import { detectImportSystem } from "./import-file-kind";

// Real file names and real first lines from both systems — see the CDCB and
// Lactanet samples under imports/.

test("content wins: a Lactanet CSV header is recognised regardless of file name", () => {
  const line = "REGISTRATION NUMBER,REGISTERED NAME,SHORT NAME,BIRTH DATE,BULLS FINAL CLASS";
  assert.equal(detectImportSystem("aiobgepa2604_ho.csv", line), "lactanet");
  // Even under a completely unrelated name (a staged/hash-prefixed file) —
  // content still wins.
  assert.equal(detectImportSystem("012d2bbf_upload.csv", line), "lactanet");
});

test("content wins: a CDCB #TYPE: preamble is recognised regardless of file name", () => {
  const line = "#TYPE:ANIM|RUN:monthly|DATE:2604|ANIM:51497|FIELDS:57";
  assert.equal(detectImportSystem("HO_all_evaluated_infoANIM_2604.csv", line), "cdcb");
  assert.equal(detectImportSystem("staged_upload.csv", line), "cdcb");
});

test("a leading UTF-8 BOM on the CDCB preamble does not defeat detection", () => {
  const line = "﻿#TYPE:EVAL|RUN:monthly|DATE:2604|ANIM:51497|FIELDS:52";
  assert.equal(detectImportSystem("HO_all_evaluated_infoEVAL_2604.csv", line), "cdcb");
});

test("filename alone: real Lactanet family names are recognised with no content", () => {
  assert.equal(detectImportSystem("aiobgepa2604_ho.csv"), "lactanet");
  assert.equal(detectImportSystem("gealltraits_bulls07992504_ho.csv"), "lactanet");
  assert.equal(detectImportSystem("gealltraits_bulls_unoff07992504_ho.csv"), "lactanet");
  assert.equal(detectImportSystem("07992604_ho.csv"), "lactanet");
});

test("filename alone: real CDCB family names are recognised with no content", () => {
  assert.equal(detectImportSystem("HO_all_evaluated_infoANIM_2604.csv"), "cdcb");
  assert.equal(detectImportSystem("AY_all_evaluated_infoEVAL_2604.csv"), "cdcb");
  assert.equal(detectImportSystem("JE_New_young_Pub_infoANIM_2604.csv"), "cdcb");
  assert.equal(detectImportSystem("HO_young_Pub_infoEVAL_20260802.csv"), "cdcb");
});

test("an unrelated file is 'unknown', not misfiled as either system", () => {
  assert.equal(detectImportSystem("random_export.csv"), "unknown");
  assert.equal(detectImportSystem("readme.txt"), "unknown");
  assert.equal(detectImportSystem("random_export.csv", "Name,Value\nfoo,1"), "unknown");
});

test("content disagreeing with a misleading name is trusted over the name", () => {
  // A CDCB file that was manually renamed to look like a Lactanet one — content
  // must win, since that's what the parser will actually read.
  const cdcbLine = "#TYPE:ANIM|RUN:monthly|DATE:2604|ANIM:100|FIELDS:10";
  assert.equal(detectImportSystem("gealltraits_bulls_renamed.csv", cdcbLine), "cdcb");
});
