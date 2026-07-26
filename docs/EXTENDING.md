# Extending the Platform

Phase 1 is deliberately genetics-only, but the schema and code were designed with clear
hooks for everything that follows. This guide covers the routine additions (traits,
breeds) and the future phases.

---

## Add a new trait

**UI:** Admin → **Traits** → pick the domain tab (Genetic / Classification) → "Add trait".
Set code, name, species (dairy/beef/both), category, unit, display order, higher-is-better.

It becomes available immediately in the relevant proof/classification entry forms
(forms read `TraitDefinition` filtered by domain and species). No migration needed —
traits are data, not columns. See [DATA-MODEL.md](DATA-MODEL.md#trait-flexibility).

## Add a new breed

**UI:** Admin → **Breeds** → "Add breed". Set code, name, species type, registry.
Immediately selectable on animals and usable for breed-scoped trait definitions and
breed-specific source priority rules.

## Add a new source / change priority

**UI:** Admin → **Sources & Priority Rules**. Add a source, then slot it into any domain's
ranked list. See [SOURCE-PRIORITY.md](SOURCE-PRIORITY.md).

---

## Future phases (hooks already in place)

### 1. CRM integration
The CRM is custom-built and integrated later. Genetics stays the system of record for
animals; the CRM links to `Animal.id`.
- **Hooks:** stable permanent `Animal.id`; `AuditLog`; role model ready for CRM roles.
- **Add:** `Farm`/`Customer`/`SalesNote`/`SemenInterest` tables referencing `Animal.id`;
  a read API over animals; do **not** fold CRM data into the genetics tables.

### 2. Public bull catalogue
- **Hooks:** `Animal`, preferred-proof resolution, `AnimalNote`, `FileAttachment`,
  marketing-code identifier type.
- **Add:** a separate public (unauthenticated) surface that reads only approved,
  preferred values for animals flagged "publishable"; PDF export; marketing pages.
  Keep it read-only against the genetics DB.

### 3. Pedigree index
Phase 1 stores pedigree **references** (`PedigreeReference`) and a **placeholder**
result table (`PedigreeIndexResult`) — it does **not** calculate an index.
- **Hooks:** `PedigreeReference` (source URL, last-checked, display status);
  `PedigreeIndexResult` (index value, `algorithmVersion`, `calculationDate`, confidence).
- **Add:** approved pedigree **relationship** records (sire/dam edges), a retrieval/upload
  path for pedigree data, then an index engine that writes versioned `PedigreeIndexResult`
  rows. A future index needs pedigree data available at calculation time — the retrieval
  hooks and snapshot references are already modelled.

### 4. Mating recommendations
- **Hooks:** flexible traits, preferred proofs, roles (donor/dam), breeds.
- **Add:** cow-group import, inbreeding checks (needs pedigree edges from phase 3),
  trait-correction logic, and a recommended-bull list generator.

### 5. Semen inventory & sales
- **Hooks:** semen-code / NAAB identifiers; `Animal` as the product's genetic root.
- **Add:** `Inventory`/`Tank`/`Order`/`Quote`/`Shipment` tables referencing `Animal.id`;
  keep commercial data out of the genetics tables.

### 6. Analytics
- **Hooks:** historical dated records for proofs/milk/classification; `Source`;
  `AuditLog`.
- **Add:** genetic-trend dashboards (trait value over proof dates), proof-movement,
  maternal-line analysis, breed comparisons, and source-quality reports — all read-only
  aggregations over existing history.

---

## Guiding principle

Keep genetics as the **system of record** for animals and their history. New domains
(CRM, sales, catalogue) should **reference** `Animal.id` from their own tables rather than
extend the genetics tables, so Phase 1 stays clean and each phase can evolve independently.
