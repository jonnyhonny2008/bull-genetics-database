# Data Model

Full schema lives in [`prisma/schema.prisma`](../prisma/schema.prisma). SQLite has no
enums or JSON scalar, so enum-like fields are `String` (validated against
`src/lib/constants.ts`) and JSON payloads are stored as `String` (JSON-stringified).

## Entity map

```
Breed 1───* Animal *───1 (breed)
Animal 1───* AnimalIdentifier      (external ids: registration, NAAB, semen, RFID, …)
Animal 1───* AnimalRole            (active stud bull, cow, donor, dam, reference sire, …)
Animal 1───* GeneticEvaluation 1───* GeneticTraitValue
Animal 1───* MilkRecord
Animal 1───* ClassificationRecord 1───* ClassificationTraitValue
Animal 1───* AnimalNote
Animal 1───* PedigreeReference
Animal 1───* PedigreeIndexResult   (placeholder for future index)
Animal 1───* FileAttachment / SourceCapture (optional links)

Source 1───* (identifiers, evaluations, milk, classifications, captures, pedigree refs)
Source 1───* SourcePriorityRule
SourceCapture 1───* ImportReviewQueue
SourceCapture 1───* FileAttachment

User, Role, ConfigValue, EnvironmentConfig, TraitDefinition, AuditLog  (reference/system)
```

## Core tables

| Model | Purpose | Notable fields |
|---|---|---|
| **Animal** | The single central entity | `id` (permanent cuid), `primaryName`, `sex`, `breedId`, `currentStatus`, `archived` |
| **AnimalIdentifier** | Many external ids per animal | `idType`, `idValue`, `sourceId`, `isPrimary` |
| **AnimalRole** | Many roles per animal, dated | `roleType`, `startDate`, `endDate`, `active` |
| **Breed** | Dairy & beef breeds | `breedCode`, `speciesType` (dairy/beef) |
| **TraitDefinition** | Flexible trait catalogue | `traitCode`, `domain` (genetic/classification), `speciesType`, `category`, `unit`, `higherIsBetter` |
| **GeneticEvaluation** | One proof run for an animal | `evaluationDate`, `proofRun`, `sourceId`, `captureId`, `approvalStatus`, `isPreferred` |
| **GeneticTraitValue** | Flexible trait values per proof | `traitCode`, `numericValue`/`textValue`, `reliability`, `percentileRank` |
| **MilkRecord** | Historical production record | `recordDate`, `lactationNumber`, `milkAmount`, `fat*`, `protein*`, `isPreferred` |
| **ClassificationRecord** | Historical classification | `classificationDate`, `finalScore`, `classificationCode`, `isPreferred` |
| **ClassificationTraitValue** | Flexible breakdown/linear traits | `traitCode`, `traitValue` (string, flexible) |
| **Source** | Where data comes from | `sourceName` (unique), `sourceType`, `defaultPriorityRank` |
| **SourceCapture** | An upload / entry event | `captureType`, `storedFileUrl`, `rawExtractedDataJson`, `extractionStatus` |
| **ImportReviewQueue** | Review item for a capture | `proposedRecordType`, `matchedAnimalId`, `matchConfidence`, `extractedDataJson`, `status` |
| **SourcePriorityRule** | Ranked preference per domain | `dataDomain`, `sourceId`, `priorityRank` (1=best), optional `breedId`/`countrySystem` |
| **PedigreeReference** | Link/reference to official pedigree | `sourceUrl`, `lastCheckedAt`, `displayStatus` |
| **PedigreeIndexResult** | **Placeholder** for future index | `indexValue`, `algorithmVersion`, `calculationDate` |
| **User / Role** | Auth + role reference | `email`, `passwordHash`, `role`; `Role` describes each role |
| **ConfigValue** | Vocab (statuses, roles, id types, …) | `category`, `code`, `label` |
| **EnvironmentConfig** | Environment marker + config | `key`, `value` (e.g. `APP_ENV`) |
| **FileAttachment** | Stored file metadata | `storedUrl`, `contentType`, `sizeBytes` |
| **AnimalNote** | Internal + data-quality notes | `body`, `noteType` |
| **AuditLog** | Change history | `entityType`, `action`, `userId`, `changesJson` |

## Why "historical"

Instead of `Animal.LPI = 3500`, the design is:

```
Animal ──has many──▶ GeneticEvaluation (by proof run / date)
GeneticEvaluation ──has many──▶ GeneticTraitValue (LPI, Pro$, Milk, …)
```

The same pattern applies to milk (by lactation/record date) and classification (by
classification date). New data = a new row. Old rows are retained for audit and for the
"why preferred" comparison. Nothing important is overwritten; animals are **archived**
(`archived = true`), never hard-deleted, by default.

## Trait flexibility

Traits are **data, not columns**. `TraitDefinition` rows (managed in Admin → Traits)
define what exists; `GeneticTraitValue` / `ClassificationTraitValue` store the actual
values. This supports dairy indexes (LPI, Pro$), production/type/health traits, and beef
EPDs (Calving Ease, Birth Weight, Marbling, Ribeye Area, …) in the same structure — and
new traits can be added at any time without a schema migration.
