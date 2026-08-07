// ---------------------------------------------------------------------------
// Import Holstein Association USA's published Holstein Conformation Composite.
//
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server \
//     prisma/import-hcc.ts <HCC_report.xlsx> [--round 2604] [--dry-run]
//
// Source: https://www.holsteinusa.com/genetic_evaluations/bull_lists.html
//         → "HCC Report for Available Bulls" (HCC_report.xlsx)
//
// WHY THIS IS IMPORTED RATHER THAN COMPUTED. UDC, FLC and BWC are derived in this
// app from the linear traits using HAUSA's published weights, and they reproduce
// exactly. The HCC cannot be: HAUSA publishes the weights, the optima and the
// direction for 18 traits, but describes the arithmetic only as "a quadratic
// penalty that grows as a bull moves further from the optimum". Fitting a full
// quadratic to HAUSA's own 4,372-bull release reaches R2 0.988 with a mean error
// of 0.078 — but only 8% of bulls land within 0.01 and the worst miss is 0.84.
// That is close enough to rank a shortlist and nowhere near close enough to print
// next to an official number, so the published value is the only one stored.
//
// COVERAGE IS NOT A BUG. HAUSA publishes HCC for AVAILABLE bulls — roughly 4,400
// of the 68,721 in a CDCB round. Every other bull keeps a null HCC. A null here
// means "not published", never "zero" and never "average".
//
// MATCHING IS ON NAAB, NORMALISED. The HAUSA file writes 200H08523 where CDCB
// writes 200HO08523 — the breed letter pair is collapsed. normalizeNaab handles
// the zero-padding; the HO/H difference is handled here.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const roundArg = (() => { const i = args.indexOf("--round"); return i >= 0 ? args[i + 1] : null; })();

if (!file || !existsSync(file)) {
  console.error("usage: import-hcc.ts <HCC_report.xlsx> [--round 2604] [--dry-run]");
  process.exit(1);
}

/** HAUSA writes 200H08523; CDCB writes 200HO08523. Compare on digits + stud code. */
function naabKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d+)\s*([A-Z]{1,2})\s*(\d+)$/.exec(String(raw).trim().toUpperCase());
  if (!m) return null;
  // Stud number and animal number carry the identity; the breed letters vary in
  // width between the two publishers, so they are dropped from the key entirely.
  return `${Number(m[1])}-${Number(m[3])}`;
}

async function main() {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file!);
  const ws = wb.worksheets[0];
  const hdr = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? "").trim());
  const col = (n: string) => hdr.indexOf(n);
  const iHcc = col("HCC"), iNaab = col("NAAB"), iName = col("Name"), iReg = col("Reg#");
  if (iHcc < 0 || iNaab < 0) {
    console.error(`Not an HCC report: needs "HCC" and "NAAB" columns. Found: ${hdr.join(", ")}`);
    process.exit(1);
  }

  const num = (v: unknown) => {
    const n = Number(v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v);
    return Number.isFinite(n) ? n : null;
  };

  const rows: { key: string; naab: string; name: string; reg: string; hcc: number }[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const vals = (ws.getRow(r).values as unknown[]).slice(1);
    const hcc = num(vals[iHcc]);
    const naab = String(vals[iNaab] ?? "").trim();
    const key = naabKey(naab);
    if (hcc == null || !key) continue;
    rows.push({
      key, naab, hcc,
      name: String(vals[iName] ?? "").trim(),
      reg: String(vals[iReg] ?? "").trim(),
    });
  }
  console.log(`${file}: ${rows.length} bulls with a published HCC`);
  const vals = rows.map((r) => r.hcc).sort((a, b) => a - b);
  const q = (p: number) => vals[Math.floor((vals.length - 1) * p)];
  console.log(`  range ${q(0).toFixed(2)} … ${q(1).toFixed(2)}   median ${q(0.5).toFixed(2)}   mean ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)}`);

  if (dryRun) { console.log("\nDRY RUN — nothing written."); return; }

  const { prisma } = await import("../src/lib/db");
  const { normalizeNaab } = await import("../src/lib/us-cdcb/identity");
  void normalizeNaab;

  // Build the NAAB index from the American roster once.
  const roster = await prisma.usAnimal.findMany({
    where: { naabCode: { not: null } },
    select: { usAnimalId: true, naabCode: true },
  });
  const byKey = new Map<string, string[]>();
  for (const a of roster) {
    const k = naabKey(a.naabCode);
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(a.usAnimalId);
    byKey.set(k, arr);
  }
  console.log(`  roster NAAB index: ${byKey.size} distinct codes over ${roster.length} bulls`);

  const source = `HCC_report${roundArg ? ` ${roundArg}` : ""}`;
  let matched = 0, written = 0, ambiguous = 0;
  const unmatched: string[] = [];
  const CHUNK = 500;
  const pending: { usAnimalId: string; hcc: number }[] = [];

  for (const r of rows) {
    const ids = byKey.get(r.key);
    if (!ids || ids.length === 0) { unmatched.push(`${r.naab} ${r.name}`); continue; }
    // A NAAB code recycled between bulls would give two roster rows. Refuse rather
    // than pick — a wrong HCC on a real bull is worse than a missing one.
    if (ids.length > 1) { ambiguous++; continue; }
    matched++;
    pending.push({ usAnimalId: ids[0], hcc: r.hcc });
  }

  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const res = await prisma.$transaction(
      slice.map((p) =>
        prisma.usEvaluation.updateMany({
          where: {
            usAnimalId: p.usAnimalId,
            isPreferred: true,
            ...(roundArg ? { roundCode: roundArg } : {}),
          },
          data: { hcc: p.hcc, hccSource: source },
        }),
      ),
    );
    written += res.reduce((a, b) => a + b.count, 0);
    process.stdout.write(`\r  writing ${Math.min(i + CHUNK, pending.length)}/${pending.length}`);
  }

  console.log(`\n\nmatched ${matched} of ${rows.length}  ·  wrote ${written} evaluation rows  ·  ${ambiguous} ambiguous NAAB skipped  ·  ${unmatched.length} not on the roster`);
  for (const u of unmatched.slice(0, 8)) console.log(`  no roster match: ${u}`);
  if (unmatched.length > 8) console.log(`  … and ${unmatched.length - 8} more`);
  console.log(`\nHCC is published for AVAILABLE bulls only. Every other bull keeps a null HCC, which means "not published" — never zero, never average.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
void readFileSync;
