# Source Priority — How "Preferred" Values Are Chosen

When the same fact (e.g. an animal's April 2026 LPI) arrives from more than one source,
the app must decide which value to treat as the **preferred** one — and be able to explain
why. That logic lives in [`src/lib/priority.ts`](../src/lib/priority.ts).

## The rule

> The preferred record is the **approved** record whose source has the **best (lowest)
> priority rank** for the relevant data domain. Ties are broken by the **most recent date**.

- Rank comes from `SourcePriorityRule` (managed in **Admin → Sources & Priority Rules**).
- **Rank 1 = most preferred.**
- A source with no explicit rule falls back to its `Source.defaultPriorityRank`.
- Only `approvalStatus = "approved"` records are eligible to be preferred.
- Lower-priority conflicting values are **kept in history** (never deleted), so the audit
  trail and the "chosen over N lower-priority record(s)" explanation remain intact.

## Data domains

Separate ranked lists exist per domain: `genetic_evaluation`, `classification`,
`milk_record`, `animal_identity`, `pedigree_display`.

## Seeded default rules (both environments)

**Genetic evaluations:** 1) LactanetGen · 2) Official Uploaded Genetic Proof File ·
3) Breed Association Record · 4) Manual Entry · 5) AI-Extracted PDF/Screenshot · 6) Catalogue PDF

**Classification:** 1) Holstein Canada · 2) Official Uploaded Classification Report ·
3) Manual Entry · 4) AI-Extracted PDF/Screenshot

**Milk records:** 1) Holstein Canada · 2) Official Uploaded Production Report ·
3) Manual Entry · 4) AI-Extracted PDF/Screenshot

**Animal identity:** 1) Breed Association Record · 2) Holstein Canada · 3) LactanetGen ·
4) Official Uploaded Genetic Proof File · 5) Manual Entry · 6) AI-Extracted

**Pedigree display:** 1) Breed Association Record · 2) Holstein Canada · 3) LactanetGen ·
4) Official Uploaded Classification Report · 5) Manual Entry

## What you see in the app

On an animal profile, the "Latest preferred genetic proof" card shows the chosen record
and a plain-English reason, e.g.:

> **Preferred** · LactanetGen · April 2026 · Rel 85%
> **Why preferred:** Highest-priority source for genetic evaluations: LactanetGen
> (priority 1), chosen over 2 lower-priority record(s). Record date 2026-04-01.

The full proof history below it lists every record, with the preferred one badged and the
lower-priority conflicting ones retained.

## How it's computed

- `loadRankMap(dataDomain, breedId?)` builds a `sourceId → rank` map, applying explicit
  rules over source defaults and preferring breed-specific rules where present.
- `pickPreferred(items, …)` filters to approved records, scores each by
  `(rank, then recency)`, sorts, and returns the winner plus the reason string.
- `recomputePreferredForAnimal(animalId)` re-persists the `isPreferred` flags across all
  three domains and runs after **every** proof/milk/classification write or review
  approval, so dashboards and lists stay consistent. (Milk is preferred per lactation
  number; classification and genetics take the single best record.)

## Changing the rules

Go to **Admin → Sources & Priority Rules**. Add/remove a rule per domain, set its rank,
optionally scope it to a breed. Changes take effect immediately on the next page load —
no migration or redeploy needed. You can also add a brand-new source in the same screen
and slot it into the ranking.
