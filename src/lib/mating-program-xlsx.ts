// Server-only: build the styled Excel workbook for the Mating Program report.
// Kept out of mating-program.ts so any client component that imports only the
// report TYPES never pulls exceljs into the browser bundle — the same split
// proof-change-xlsx.ts uses.
//
// Five sheets, in the order a user works through them:
//   1 Recommendations — the cleared bulls, best first. The only actionable list.
//   2 Excluded        — the audit trail. Which bull, which shared ancestor, and
//                       where that ancestor sits on EACH side. This sheet is the
//                       reason the report can be trusted; it is never collapsed
//                       into a count.
//   3 Unverified      — pairs we could not certify, with the dark branch named.
//   4 Bull coverage   — bull × how many females he is cleared for + mean PA.
//                       The semen-order sheet.
//   5 Run parameters  — every parameter, every warning, and the ceiling
//                       disclaimer, so a printed copy can be reproduced.

import ExcelJS from "exceljs";
import { MATING_INDEXES, type MatingFemale, type MatingReport } from "./mating-program";

const HEADER_FILL = "FF0F3D3E"; // navy/teal header band
const HEADER_FONT = "FFFFFFFF";
const RED = { fill: "FFFDE7E7", font: "FFB91C1C" };
const AMBER = "FFFFF3CD";
const GREY = "FFF3F4F6";

function headerRow(sheet: ExcelJS.Worksheet, cells: string[]) {
  const row = sheet.addRow(cells);
  row.font = { bold: true, color: { argb: HEADER_FONT } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return row;
}

/** "her MGS × his sire" style label, plus the raw generations on each side. */
function relationshipLabel(cowGen: number, bullGen: number, fallback: string): string {
  if (cowGen === 0 && bullGen === 0) return "the same animal";
  if (bullGen === 0) return "the bull IS her ancestor";
  if (cowGen === 0) return "she IS his ancestor";
  return fallback;
}

const genText = (g: number) => (g === 0 ? "the animal itself" : `generation ${g}`);

/**
 * The bull pool, in the same words the form uses. Keyed on every member of
 * MatingParams["pool"], so adding a pool to the menu without describing it here
 * is a compile error rather than a blank cell on the parameter sheet.
 */
const POOL_NOTE: Record<MatingReport["params"]["pool"], { label: string; note: string }> = {
  blondin: { label: "Blondin bulls", note: "The Blondin house lineup only." },
  proven: { label: "Active proven", note: "Bulls with an active proof and daughter-based EBVs." },
  genomic: { label: "Active genomic", note: "Bulls with an active proof and GPA genomics only — not yet proven." },
  all: { label: "Whole database", note: "The whole male database, subject to the inactive toggle below." },
};

function femaleLabel(f: MatingFemale): string {
  return f.name ? `${f.name} (${f.reg})` : f.reg;
}

/**
 * Download filename: purpose first so the files group when sorted, then the
 * index and the pool, then the date it was generated.
 *   Mating Program - LPI - blondin - 12 females - generated 2026-08-03.xlsx
 */
export function matingProgramFilename(r: MatingReport): string {
  const generated = (r.generatedAt ?? new Date().toISOString()).slice(0, 10);
  const idx = MATING_INDEXES.find((i) => i.code === r.params.index);
  const n = r.females.length;
  const bits = [
    "Mating Program",
    idx?.label ?? r.params.index,
    POOL_NOTE[r.params.pool].label,
    `${n} female${n === 1 ? "" : "s"}`,
    `generated ${generated}`,
  ];
  if (r.params.maxGen === 0) bits.splice(3, 0, "AUDIT MODE - UNSCREENED");
  return `${bits.join(" - ").replace(/[\\/:*?"<>|]/g, "-")}.xlsx`;
}

export async function buildMatingProgramWorkbook(r: MatingReport): Promise<ExcelJS.Workbook> {
  const idx = MATING_INDEXES.find((i) => i.code === r.params.index);
  const indexLabel = idx?.label ?? r.params.index;
  const audit = r.params.maxGen === 0;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Bull Stud Genetics";
  wb.created = new Date(r.generatedAt ?? Date.now());
  wb.title = `Mating Program — ${indexLabel}`;
  wb.subject = "Bull recommendations screened for shared ancestry";
  wb.description =
    `${r.females.length} females against ${r.bullsConsidered} bulls, ranked on ${indexLabel}. ` +
    (audit
      ? "AUDIT MODE: relatedness screening was OFF — nothing in this workbook has been cleared for mating."
      : `Screened to ${r.params.maxGen} generations, confidence floor ${r.params.floor}.`);

  // ---- Sheet 1: Recommendations -------------------------------------------
  const s1 = wb.addWorksheet("Recommendations");
  const paCols = MATING_INDEXES.map((m) => `PA ${m.label}`);
  headerRow(s1, [
    "Female",
    "Female reg",
    "Source",
    "Rank",
    "Bull",
    "NAAB",
    "Bull reg",
    `Bull ${indexLabel}`,
    `Projected calf ${indexLabel}`,
    "Ranking basis",
    "Confidence",
    "Bull ancestors known",
    ...paCols,
  ]);

  if (audit) {
    const row = s1.addRow([
      "AUDIT MODE — screening was OFF. No bull in this run has been cleared for mating; see the Unverified sheet for the unscreened ranking.",
    ]);
    row.font = { bold: true, color: { argb: RED.font } };
    s1.mergeCells(row.number, 1, row.number, 12);
  }

  for (const f of r.females) {
    if (f.error) {
      const row = s1.addRow([femaleLabel(f), f.reg, f.source ?? "", "", f.error]);
      row.font = { bold: true, color: { argb: RED.font } };
      row.eachCell((c) => {
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: RED.fill } };
      });
      continue;
    }
    if (!f.matches.length) {
      const row = s1.addRow([
        femaleLabel(f),
        f.reg,
        f.source ?? "",
        "",
        "No bull in the pool could be cleared for this female — see the Excluded and Unverified sheets.",
      ]);
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
      continue;
    }
    f.matches.forEach((m, i) => {
      const byCode = new Map(m.pa.map((p) => [p.code, p.value]));
      const row = s1.addRow([
        i === 0 ? femaleLabel(f) : "",
        i === 0 ? f.reg : "",
        i === 0 ? f.source ?? "" : "",
        i + 1,
        m.name,
        m.naab ?? "",
        m.reg ?? "",
        m.ownIndex,
        m.paIndex,
        f.paBasis === "pa" ? `parent average (${indexLabel})` : `bull's own ${indexLabel} — dam has no ${indexLabel}`,
        m.confidence,
        `${m.bullSlots} of 14`,
        ...MATING_INDEXES.map((mi) => byCode.get(mi.code) ?? null),
      ]);
      if (f.paBasis !== "pa") row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
      if (i === 0) row.getCell(1).font = { bold: true };
    });
    // Per-female notes travel with the block they qualify.
    for (const n of f.notes) {
      const row = s1.addRow(["", "", "", "", `Note: ${n}`]);
      row.font = { italic: true };
      row.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
    }
  }
  s1.columns.forEach((c, i) => {
    c.width = i === 0 ? 30 : i === 4 ? 28 : i === 9 ? 34 : i < 3 ? 18 : 13;
  });

  // ---- Sheet 2: Excluded (the audit trail) --------------------------------
  const s2 = wb.addWorksheet("Excluded");
  headerRow(s2, [
    "Female",
    "Female reg",
    "Bull",
    "Shared ancestor",
    "Shared ancestor reg",
    "Where on HER side",
    "Where on HIS side",
    "Relationship",
    "Closeness (lower is closer)",
  ]);
  for (const f of r.females) {
    for (const x of f.excluded) {
      for (const s of x.shared) {
        s2.addRow([
          femaleLabel(f),
          f.reg,
          x.name,
          s.name ?? "(name not recorded)",
          s.reg,
          genText(s.cowGen),
          genText(s.bullGen),
          relationshipLabel(s.cowGen, s.bullGen, s.label),
          s.cowGen + s.bullGen,
        ]);
      }
    }
  }
  if (s2.rowCount === 1) s2.addRow(["No bull was excluded in this run."]);
  s2.columns.forEach((c, i) => {
    c.width = i === 0 ? 30 : i === 2 || i === 3 ? 28 : i === 7 ? 34 : 18;
  });

  // ---- Sheet 3: Unverified -------------------------------------------------
  const s3 = wb.addWorksheet("Unverified");
  headerRow(s3, [
    "Female",
    "Female reg",
    "Bull",
    "NAAB",
    `Bull ${indexLabel}`,
    `Projected calf ${indexLabel}`,
    "Confidence",
    "Female ancestors known",
    "Bull ancestors known",
    "Why it could not be checked",
  ]);
  for (const f of r.females) {
    for (const m of f.unknown) {
      // The engine's own per-pair reason, which names WHICH side is blind and
      // which branch of it. Confidence is min(cow, bull), so a generic sentence
      // here would be a false statement about whichever side is fully recorded.
      const why =
        m.reason ||
        (m.confidence === 0
          ? "no usable pedigree on one side — nothing could be screened"
          : `pedigree confidence ${m.confidence} is below the ${r.effectiveFloor} floor — a shared ancestor could be hidden in an unrecorded branch`);
      const row = s3.addRow([
        femaleLabel(f),
        f.reg,
        m.name,
        m.naab ?? "",
        m.ownIndex,
        m.paIndex,
        m.confidence,
        `${f.cowSlots} of 14`,
        `${m.bullSlots} of 14`,
        audit ? "AUDIT MODE — no screening was performed" : why,
      ]);
      row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
    }
  }
  if (s3.rowCount === 1) s3.addRow(["Every pair in this run could be verified."]);
  s3.columns.forEach((c, i) => {
    c.width = i === 0 ? 30 : i === 2 ? 28 : i === 9 ? 56 : 16;
  });

  // ---- Sheet 4: Bull coverage (the semen-order sheet) ---------------------
  const s4 = wb.addWorksheet("Bull coverage");
  headerRow(s4, [
    "Bull",
    "NAAB",
    "Bull reg",
    `Bull ${indexLabel}`,
    "Females cleared for",
    "% of females in the run",
    `Mean projected calf ${indexLabel}`,
    "Best rank achieved",
    "Females",
  ]);
  interface Cover {
    name: string;
    naab: string | null;
    reg: string | null;
    own: number | null;
    females: string[];
    paSum: number;
    paN: number;
    bestRank: number;
  }
  const cover = new Map<string, Cover>();
  for (const f of r.females) {
    f.matches.forEach((m, i) => {
      const c = cover.get(m.bullId) ?? {
        name: m.name,
        naab: m.naab,
        reg: m.reg,
        own: m.ownIndex,
        females: [],
        paSum: 0,
        paN: 0,
        bestRank: Number.POSITIVE_INFINITY,
      };
      c.females.push(f.name ?? f.reg);
      if (m.paIndex != null) {
        c.paSum += m.paIndex;
        c.paN++;
      }
      c.bestRank = Math.min(c.bestRank, i + 1);
      cover.set(m.bullId, c);
    });
  }
  const total = r.females.filter((f) => !f.error).length;
  const lowerBetter = r.params.index === "SCS";
  [...cover.values()]
    .sort((a, b) => {
      if (b.females.length !== a.females.length) return b.females.length - a.females.length;
      const am = a.paN ? a.paSum / a.paN : null;
      const bm = b.paN ? b.paSum / b.paN : null;
      if (am == null || bm == null) return a.name.localeCompare(b.name);
      return lowerBetter ? am - bm : bm - am;
    })
    .forEach((c) => {
      s4.addRow([
        c.name,
        c.naab ?? "",
        c.reg ?? "",
        c.own,
        c.females.length,
        total ? Math.round((c.females.length / total) * 100) : 0,
        c.paN ? Math.round((c.paSum / c.paN) * 100) / 100 : null,
        Number.isFinite(c.bestRank) ? c.bestRank : null,
        c.females.join("; "),
      ]);
    });
  if (s4.rowCount === 1) s4.addRow(["No bull was cleared for any female in this run."]);
  s4.columns.forEach((c, i) => {
    c.width = i === 0 ? 28 : i === 8 ? 60 : 16;
  });

  // ---- Sheet 5: Run parameters --------------------------------------------
  const s5 = wb.addWorksheet("Run parameters");
  headerRow(s5, ["Parameter", "Value", "What it means"]);
  const add = (k: string, v: string | number | null, why: string) => s5.addRow([k, v, why]);

  add("Generated", r.generatedAt, "Timestamp of the run. Proofs move; a stale copy of this sheet is not a current recommendation.");
  add("Index", indexLabel, `Bulls are ranked on the projected calf ${indexLabel}.${lowerBetter ? " A LOWER SCS is the better animal, so this run was ranked ascending." : ""}`);
  add("Generations screened", audit ? "OFF (audit mode)" : r.params.maxGen, audit ? "NO relatedness screening was performed in this run." : "A shared ancestor is looked for this many generations back on both sides.");
  add("Bull pool", POOL_NOTE[r.params.pool].label, POOL_NOTE[r.params.pool].note);
  add("Include inactive bulls", r.params.includeInactive ? "yes" : "no", "Inactive bulls have no proof in the most recent round on file.");
  add(
    "NAAB code only",
    r.params.naabOnly ? "yes" : "no",
    r.params.naabOnly
      ? "Restricted to bulls carrying a NAAB stud code — semen that can actually be ordered."
      : "Every bull in the pool was considered, including any with no stud code on file.",
  );
  add("Bulls considered", r.bullsConsidered, "Bulls that passed the pool filters and were screened against every female.");
  add("Inactive bulls suppressed", r.inactiveSuppressed, "Bulls removed from the pool because they have no active proof.");
  add("Top N per female", r.params.topN, "How many cleared bulls are listed for each female.");
  add("Confidence floor", r.params.floor, "A pair is only recommended when BOTH pedigrees are at least this complete. Below it the pair is withheld, not demoted.");
  add(
    "Confidence floor applied",
    r.effectiveFloor,
    r.effectiveFloor === r.params.floor
      ? "Same as the floor above — completeness was measured over the full three generations."
      : `Completeness is normalised over the ${r.params.maxGen} generations actually screened, so the floor was scaled by the same factor. It demands the SAME amount of pedigree evidence as ${r.params.floor} does at three generations — a shallower screen is not a lower bar.`,
  );
  add("Females submitted", r.females.length, "After de-duplication and the 50-female cap.");
  add("Females that failed closed", r.females.filter((f) => f.error).length, "Females whose pedigree could not be read. They produce ZERO recommendations by design.");
  add("Median exclusion rate", `${r.medianExclusionPct}%`, "Median share of the bull pool removed per female for shared ancestry.");
  add("Ancestor resolve rate", r.keyResolveRate, "Share of the ancestors met in this run that are animals we hold, and could therefore be matched across all their registration numbers.");

  s5.addRow([]);
  const disclaimerHead = s5.addRow(["How to read this workbook"]);
  disclaimerHead.font = { bold: true };
  const notes: string[] = [
    "THE THREE-GENERATION CEILING. Ancestry is screened to at most three generations. A common ancestor further back than that is NOT detected and NOT reported. \"No shared ancestor\" in this workbook means \"none inside the screened window\", never \"unrelated\".",
    "Confidence is the MINIMUM of the two pedigrees' completeness, never a product and never an average. A shared ancestor is only detectable if BOTH sides recorded it, so the screen is exactly as good as its blinder half.",
    "An ancestor named without a registration number counts as unknown. It cannot be matched, so it does not raise confidence.",
    "The Unverified sheet is NOT a second-choice list. Those pairs were withheld because a shared ancestor could be hiding in a branch nobody recorded.",
    "No inbreeding-depression penalty is applied. There is no defensible published Canadian coefficient to apply, so the ranking is the parent average only.",
    "Registration numbers are compared, names never are. Holstein herd prefixes collide constantly, so a name match alone is not treated as a relationship.",
  ];
  if (audit) {
    notes.unshift(
      "AUDIT MODE. Relatedness screening was switched OFF for this run. Nothing in this workbook has been cleared for mating; the Excluded sheet shows only what a 3-generation screen WOULD have removed.",
    );
  }
  for (const n of notes) s5.addRow(["", "", n]);

  if (r.warnings.length) {
    s5.addRow([]);
    const wh = s5.addRow(["Warnings raised by this run"]);
    wh.font = { bold: true, color: { argb: RED.font } };
    for (const w of r.warnings) {
      const row = s5.addRow(["", "", w]);
      row.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER } };
    }
  }

  s5.addRow([]);
  const fh = s5.addRow(["Females submitted"]);
  fh.font = { bold: true };
  for (const f of r.females) {
    s5.addRow([
      "",
      f.reg,
      [
        f.name ?? "(name not resolved)",
        f.source ? `source: ${f.source}` : "not resolved",
        `${f.cowSlots} of 14 ancestors known (completeness ${f.cowComplete})`,
        f.error ?? `${f.matches.length} recommended, ${f.unknown.length} unverified, ${f.excludedTotal} excluded`,
      ].join(" · "),
    ]);
  }

  s5.getColumn(1).width = 30;
  s5.getColumn(2).width = 24;
  s5.getColumn(3).width = 110;
  s5.getColumn(3).alignment = { wrapText: true, vertical: "top" };

  return wb;
}
