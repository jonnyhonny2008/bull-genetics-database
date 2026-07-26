# Official Data Sources (the compliant, reg‑number route) — researched

The sanctioned way to get "registration number in → full female profile out" is an
**official herd data file** you download as a member, then bulk‑import — like the Lactanet
bull‑proof CSV already does. No scraping of holstein.ca (`/AIS/` is disallowed for bots).

## The recommended source for FEMALE data: Lactanet **Genetic Herd Inventory** / DairyComp export

Lactanet produces, for your own herd, a file/feed of **every animal keyed by registration
number** with exactly the fields this app models:

- **Genetic Herd Inventory Report** — complete herd listing with **registration #, sire,
  % inbred, LPI, Pro$, and production** info; genetic indexes for cows and Parent Averages
  (PA) for heifers; herd vs national averages. Issued after the December evaluation round.
- **Genetic evaluations → DairyComp feed** — for all registered animals in your Lactanet
  herd inventory, updated the **first Tuesday monthly**. Importable fields: **LPI, Pro$,
  Production, Type and Functional traits, polled status, inbreeding, and milk casein (A2)** —
  i.e. the whole genomic profile, per registration number.

This is the "one file → whole herd" route. Ask Lactanet Customer Service for the Genetic
Herd Inventory data file (or the DairyComp genetic export), then drop it in `imports/` and
I add the column mapping — same pattern as the bull CSV.

- Data files & layouts: <https://lactanet.ca/en/genetics/genetic-evaluations/data-files/>
  and the linked **Data File Layouts** page (exact column specs).
- Contact: West CSD@lactanet.ca / 1‑800‑549‑4373 · East service.clientele@lactanet.ca / 1‑800‑266‑5248 · member portal sites.lactanet.ca (MYSITE).

## Compass — the female genetics hub (Holstein Canada + Lactanet)

**compasscan.ca** — free; log in with a **Lactanet number or Holstein Canada Account
number + Prefix**. Provides the **most accurate genetic evaluations for all females in the
herd** as milk‑recording and classification data accumulate; you **upload your herd
inventory** and it builds herd charts/groups. Good source for female genomic evaluations
and herd inventory export. (Females now get **monthly** genomic evaluations in Canada.)

## Actual milk / lactation records → Lactanet **milk recording (DHI)** reports

Real per‑lactation and test‑day records (milk/fat/protein, DIM, calving) come from your
**milk‑recording (DHI) reports**, not the Holstein.ca page (which shows only *genomic*
production EBVs). Available through your Lactanet milk‑recording account / herd‑management
reports, and exportable to herd software (DairyComp 305, etc.).

## Classification + pedigree → Holstein Canada **Web Account → Herd Management**

Log into your Holstein Canada web account → **Online Services → Herd Management** → list
type **"Owned & Bred"** shows your full herd; you can download **Certificates of Registry
(pedigrees)**. Classification data and pedigrees for your herd are member‑accessible; ask
member services about a **bulk herd data export** format. Pedigrees can also be ordered
online or via Customer Service.

## Summary — what to request, and what the importer expects

| Need | Best official source | How to get it |
|---|---|---|
| Female **genomics** (LPI/Pro$/prod/type/functional/A2/inbreeding), whole herd | **Lactanet Genetic Herd Inventory** file / DairyComp genetic export | Lactanet Customer Service / MYSITE portal |
| Female genomic evaluations + herd analysis | **Compass** (compasscan.ca) | Free login (Lactanet # or HC account # + prefix) |
| Real **milk / lactation** records | **Lactanet milk‑recording (DHI)** reports | Milk‑recording account / herd software export |
| **Classification** + **pedigree** | **Holstein Canada** Web Account → Herd Management | Member login; certificates + herd list |

**Importer expectation:** any **CSV/Excel keyed by registration number**. The Lactanet
importer (`src/lib/lactanet.ts`) already maps a 274‑column layout; a new herd file just
needs a column→trait mapping (a quick add). **Send one sample of the Genetic Herd Inventory
file (or DairyComp export)** and it becomes a one‑click, whole‑herd bulk import by
registration number — the true "reg‑number‑in" experience, no page copying.

## Sources
- [Lactanet — Data Files](https://lactanet.ca/en/genetics/genetic-evaluations/data-files/)
- [Lactanet — Data File Layouts](https://lactanet.ca/en/genetics/genetic-evaluations/data-file-layouts/)
- [Lactanet — Genetic Herd Inventory Report](https://lactanet.ca/en/genetic-herd-inventory-report/)
- [Lactanet — Genetic Evaluations to DairyComp!](https://lactanet.ca/en/genetic-evaluations-to-dairycomp/)
- [Lactanet — Monthly Genetic Evaluations for Females in Canada](https://lactanet.ca/en/monthly-genetic-evaluations-for-females-in-canada-monthly-genetic-evaluations/)
- [Compass](https://www.compasscan.ca/)
- [Holstein Canada — Genetic Information & Services](https://www.holstein.ca/Public/en/Services/Genetic_Information__and__Services/Genetic_Information__and__Services)
- [Holstein Canada — Classification](https://www.holstein.ca/Public/en/Services/Classification/All-Breeds_Classification) · [Pedigrees](https://www.holstein.ca/Public/en/Services/Pedigrees/Pedigrees)
