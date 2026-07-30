# Importers

Two importers turn official/authenticated data into full animal profiles (identity,
genomics, production, functional traits, conformation + **linear graph**, classification,
pedigree). Both respect Holstein Canada's access rules — nothing scrapes their site.

## 1. Lactanet bull‑proof CSV importer  (`/import-proofs`)

Parses the official Lactanet Holstein bull‑proof file (e.g. `aiobgepa2604_ho.csv`,
274 columns, ~99k bulls). Code: `src/lib/lactanet.ts`.

- **Setup:** drop the CSV into `imports/` (server‑side, no upload‑size limit).
- **Single import:** enter a **registration number or NAAB code** → creates/updates the
  animal with a full dated genomic evaluation (indexes LPI/Pro$/PI/LTI/HWI/RI/MI/EI,
  production EBVs, ~20 functional traits, conformation composites, and all linear traits),
  identifiers (registration, NAAB, marketing code), and a pedigree reference. Source =
  LactanetGen (rank 1), so the value is "preferred" with the reason shown.
- **Bulk import:** top‑N by LPI / Pro$ / LTI / HWI — for a working set of reference sires.
- The file streams line‑by‑line, so it's fast and memory‑safe.

### Add another Lactanet file format
Add a column→trait map in `src/lib/lactanet.ts` (see `INDEX_MAP`, `PROD_MAP`, `FUNC_MAP`,
`CONF_MAP`, `LINEAR_MAP`). Linear traits store a signed value + descriptor letter.

## 2. Holstein.ca paste importer  (`/holstein-lookup`)

**Paste path (no automated fetching):** you — signed into your own Holstein.ca session —
open the animal page, copy it (Ctrl+A, Ctrl+C), and paste it in. Code:
`src/lib/holstein.ts` (`parseHolsteinAis`). Nothing is requested from holstein.ca.

> ⚠️ **This statement no longer covers the whole app.** The browser scraper added later
> (`src/lib/holstein-browser.ts`, used by `/api/holstein/lookup` and `/api/holstein/import`)
> **does** request `/en/AIS/AIS?animalRegNo=…` automatically, via a real Chrome. That is the
> same path this section was originally written to say the app never fetches, so treat the
> "compliant by design" claim as applying to the *paste* importer only.
>
> Two things to settle before relying on the scraper in production:
> 1. **robots.txt** — confirm the current holstein.ca robots.txt position on `/AIS/`, and
>    whether your account/agreement permits automated retrieval. The paste importer exists
>    precisely because the original answer was "no".
> 2. **`--disable-blink-features=AutomationControlled`** (`holstein-browser.ts`) exists only
>    to hide the automation signal from bot detection. Decide deliberately whether to keep it.
>
> The interstitial handling added alongside this note is strictly passive — it waits for a
> challenge to clear on its own and otherwise fails with a clear error. It does not solve
> CAPTCHAs or evade bot detection, and should not be extended to.

From the pasted **Main** (AIS) page it extracts and imports:
- **Identity:** name, registration, national ID, birth date, purity, herd #, colour,
  beta casein, %INB / %R → creates/updates the female (roles Cow + Dam).
- **Genomic evaluation** (CAN‑GEBV, e.g. Jul 2026): GLPI→LPI, Pro$, production EBVs,
  15 functional traits, conformation composites, and all linear traits → source
  LactanetGen; renders in the linear graph.
- **Classification:** VG/EX + final score + section scores (MS/F&L/DS/RP) → a
  classification record, source Holstein Canada.
- **Pedigree:** sire + dam (reg + name) → pedigree reference with the AIS link.

### Additional tabs (add when you paste a sample of each)
The parser is layout‑specific and tuned from a real sample, so each tab needs one sample
paste to build accurately:
- **Lactations** tab → real per‑lactation milk/fat/protein records.
- **Conformation** tab → full classification descriptive breakdown.
- **Family Tree** tab → extended (multi‑generation) pedigree.
- **Shows & Awards** tab → show/award history.

Verified end‑to‑end on real animals: bull **FARNEAR DELTA‑LAMBDA** (`HO840M3125993715`)
from the CSV, and cow **BLONDIN DESTINATION SPAIN** (`HOCANF121135242`) from a paste.

## 3. Official herd data files (recommended path)

For your own herd's real milk records, classification, and genomics in bulk, use an
official export (Lactanet/DHI/Holstein Canada) rather than page copying — see
[DATA-SOURCES.md](DATA-SOURCES.md). Send one sample file and the mapping is a quick add.
