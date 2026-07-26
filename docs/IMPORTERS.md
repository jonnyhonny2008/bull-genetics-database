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

**Compliant by design:** Holstein.ca's robots.txt disallows automated access to `/AIS/`,
so the app never fetches it. Instead you — signed into your own Holstein.ca session —
open the animal page, copy it (Ctrl+A, Ctrl+C), and paste it in. Code:
`src/lib/holstein.ts` (`parseHolsteinAis`).

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
