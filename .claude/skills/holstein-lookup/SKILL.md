---
name: holstein-lookup
description: >
  Scrape animals from Holstein Canada (holstein.ca) by registration number and
  import their identity, genetics, classification and pedigree into the Bull Stud
  Platform database. Use whenever the user wants to bulk-import Holstein.ca animals
  from a list of registration numbers (CSV/Excel/pasted), refresh an animal's
  Holstein data, or "look up" cows/bulls by reg#. Triggers: "import from
  holstein.ca", "scrape these reg numbers", "add these cows", "bulk lookup".
---

# Holstein.ca lookup & bulk import

Pulls public animal data from holstein.ca and lands it in the platform DB
(Animal + identifiers + genomic evaluation + classification + pedigree).

## Why it works this way (read first)

- holstein.ca's WAF returns **403 to any server-side/bot HTTP client**, so the
  data can only be fetched **inside a real browser session**. All the data used
  is on the **public** animal pages (no login required).
- The scrape therefore runs in the user's browser via `scripts/holstein-extract.js`
  (same-origin `fetch()` of the Main + Genetics pages — fast, no navigation).
- Parsing and DB upsert are versioned, unit-tested code:
  - `src/lib/holstein-parse.ts` → `parseHolsteinExtract(raw)` (pure, tested in
    `src/lib/holstein-parse.test.ts` — run `npm run test:holstein`).
  - `src/lib/holstein-import.ts` → `importParsedHolstein(prisma, parsed, reg, deps)`.

## Two ways to run it

### A. In-app (what an end user does)
Go to the **Holstein.ca Lookup** tab in the app:
1. **Step 1** — paste the reg-number list → the tab generates a browser snippet.
2. Run that snippet in the browser console on holstein.ca → a
   `holstein-batch-*.json` downloads.
3. **Step 2** — upload that file → everything imports in one pass.
(There is also a single-animal paste box for one-offs.)

### B. Agent-driven (this skill)
When the user gives you a reg list and asks you to import it:

1. **Collect reg numbers** from the user's message / CSV / Excel column.
   Valid forms: `HOCANM…`, `HOCANF…`, or bare `HO…` numbers.
2. **Open the browser** (Claude-in-Chrome for the user's real session) to
   `https://www.holstein.ca/en/AIS/Search`. No login needed.
3. **Inject the scraper**: paste the contents of `scripts/holstein-extract.js`
   into the page via `javascript_tool`, then run (top-level await):
   ```js
   window.__HOLSTEIN = await scrapeHolstein(["HOCANM120781841", ...], { delayMs: 400 });
   ```
   - It polls each animal (Main + Genetics), logs progress, keeps partials on
     `window.__HOLSTEIN`, and downloads `holstein-batch-<n>-<ts>.json`.
   - NOTE: the browser privacy guard may block you from *reading back* the raw
     JSON through the tool (it contains National IDs). That's fine — the
     **downloaded file** is the handoff, not your tool read.
4. **Import** the downloaded batch file:
   - Move it into `imports/holstein/` (create the dir if missing), then:
     ```bash
     npm run import:holstein:demo            # or :prod
     # or a specific file:
     npm run import:holstein:demo -- imports/holstein/holstein-batch-12-....json
     ```
   - …**or** have the user upload it in the app's Holstein.ca Lookup tab (Step 2).
5. **Report** the summary the importer prints (animals / new / evals /
   classifications / errors) and link a couple of imported animals.

## Notes
- Run labels use full month names ("April 2026") to match `import-cdn.ts` and
  dedupe per source (`LactanetGen` for the evaluation, `Holstein Canada` for
  identity/classification/pedigree).
- Re-running is idempotent: an existing (animal, run, source) evaluation is
  replaced, not duplicated; preferred flags + derived sire columns are
  recomputed at the end.
- Be polite: keep `delayMs` ≥ 300 for large lists.
- The importer needs `Source` rows `Holstein Canada` and `LactanetGen` and a
  Holstein `Breed` (`HO`) — seeded by `npm run seed:config:*`.
