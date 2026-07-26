# Upload → Capture → Review → Approve

Phase 1 turns uploaded files and captured data into reviewed, approved, source-traced
records. Full automated AI extraction is a **placeholder** in Phase 1 — the workflow is
real and complete; the extraction step is simulated by supplying/adjusting the JSON that
would be extracted.

## The pipeline

```
Upload Center (/uploads)
  1. Choose a file (CSV/Excel/PDF/image/report) — optional
  2. Pick a source + capture type + proposed record type
  3. Optionally link to an animal (else auto-match at review)
  4. Provide/adjust the "extracted data" JSON
        │
        ▼
  SourceCapture created  ── file stored in uploads/<env>/ , FileAttachment recorded
        │
        ▼
  ImportReviewQueue item created (status = pending), with an animal auto-match attempt
        │
        ▼
Review Queue (/review)
  • edit extracted JSON, set matched animal, add notes
  • Approve → creates the REAL record (proof / milk / classification / animal / identifier)
             linked to the capture's source and captureId, then recomputes preferred
  • or Reject / Mark duplicate / Needs info / Conflict / Reopen
        │
        ▼
  Record appears in the animal's history + Source history, respecting source priority
```

## Statuses

`pending` · `approved` · `rejected` · `needs_more_info` · `duplicate` · `conflict_review`

The Review Queue has a filter chip per status with live counts.

## Animal matching

On upload (and in review), the app attempts to match an animal using:

- Exact identifier match (registration / NAAB / semen code / source id) → high confidence
- Name similarity, boosted by matching breed and sex → medium confidence

Matches are **shown with a confidence %**, never silently merged. You choose the matched
animal in the review item before approving.

## What "Approve" creates

The approve action (`src/app/(app)/review/actions.ts`) reads `proposedRecordType` and the
extracted JSON:

| Proposed type | Result | Requires |
|---|---|---|
| `genetic_evaluation` | New `GeneticEvaluation` + `GeneticTraitValue`s from `traits{}` | matched animal |
| `milk_record` | New `MilkRecord` | matched animal |
| `classification` | New `ClassificationRecord` + trait values | matched animal |
| `animal` | New `Animal` + identifiers (+ optional proof); capture re-linked to it | — |
| `identifier` | New `AnimalIdentifier` on the animal | matched animal |

Every created record carries the capture's `sourceId` and `captureId`, so it shows up
under the animal's **Source history** and participates in source-priority resolution.

## Extraction JSON shapes

```jsonc
// genetic_evaluation
{ "evaluationDate": "2026-08-01", "proofRun": "August 2026",
  "traits": { "LPI": 3555, "PRO$": 2810, "MILK": 1560, "FAT": 90 } }

// animal (creates a new animal, optionally with a proof)
{ "primaryName": "WESTVIEW COMET", "breedCode": "HO", "sex": "M",
  "identifiers": [{ "idType": "naab", "idValue": "007HO16999" }],
  "proof": { "proofRun": "April 2026", "traits": { "LPI": 3210 } } }

// milk_record
{ "recordDate": "2024-06-01", "lactationNumber": 3, "milk": 13200, "fat": 520,
  "fatPercent": 3.94, "protein": 430, "proteinPercent": 3.26 }

// classification
{ "classificationDate": "2024-06-15", "final": 92, "code": "EX",
  "traits": { "C_MAMM": 93, "C_FL": 90 } }
```

## Try it in the demo

The demo seeds three review items: a pending proof matched to *Maple-Crest Thunder*, a
new-animal proposal (*Westview Comet*, no confident match), and a conflict item for
*Conflict-View Lady*. Open **Review Queue**, adjust the JSON if you like, choose a matched
animal, and click **Approve → create record**; then open that animal to see the new record
in its history.
