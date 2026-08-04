// Verification (not part of the app): render the forecast table with REAL data.
//
//   npx tsx --conditions=react-server prisma/render-forecast.ts
//
// The page itself sits behind a login, so it cannot be opened here. This renders
// the component that does the actual work — every row, every expanded detail
// panel — against the live report object, which catches the failure mode a build
// cannot: a null slipping through into JSX at runtime.

import React from "react";
import { renderToString } from "react-dom/server";
import { getProofForecastReport, KEY_TRAITS } from "../src/lib/proof-forecast";
import { buildProofForecastWorkbook } from "../src/lib/proof-forecast-xlsx";
import { prisma } from "../src/lib/db";

// Next compiles components with the automatic JSX runtime, so they never import
// React themselves. This standalone runner uses the classic transform, which
// expects `React` in scope — so provide it, then load the component.
(globalThis as unknown as { React: typeof React }).React = React;

async function main() {
  const { ProofForecastTable } = await import("../src/components/ProofForecastTable");
  const report = await getProofForecastReport({});
  console.log(`  report: ${report.rows.length} rows for ${report.targetLabel}`);

  const html = renderToString(
    React.createElement(ProofForecastTable, {
      rows: report.rows,
      keyTraits: KEY_TRAITS,
      sort: report.sort,
      dir: report.dir,
      params: {},
      basePath: "/reports/proof-forecast",
      targetLabel: report.targetLabel,
      isApril: report.targetIsApril,
    }),
  );
  console.log(`  rendered ${html.length} chars of HTML`);

  // React's server renderer separates adjacent expressions with <!-- --> markers,
  // so strip them before matching text that spans more than one expression.
  const text = html.replace(/<!--\s*-->/g, "");

  // Every key trait must carry a projected value and a confidence figure.
  const withConf = report.rows.filter((r) =>
    r.forecast.keyForecasts.length > 0 &&
    r.forecast.keyForecasts.every((k) => k.predicted != null && k.confidence != null));

  const checks: [string, boolean][] = [
    ["every bull is present", report.rows.every((r) => html.includes(r.name.slice(0, 12)))],
    ["every bull has a projection + confidence on all key traits", withConf.length === report.rows.length],
    ["confidence percentages rendered", (html.match(/>\d{1,3}%</g) ?? []).length >= report.rows.length],
    ["overall confidence per bull", report.rows.every((r) => r.forecast.confidencePct != null)],
    ["confidence is a real share (0-100%)", report.rows.every((r) =>
      r.forecast.keyForecasts.every((k) => k.confidence == null || (k.confidence >= 0 && k.confidence <= 1)))],
    ["no literal 'undefined'", !html.includes("undefined")],
    ["no literal 'NaN'", !html.includes("NaN")],
    ["no stale 'No material change'", !html.includes("No material change")],
    // Odds were rendered as "↑38"; a bare arrow is just the sort indicator.
    ["no leftover odds arrows", !/[↑↓]\s*\d/.test(text)],
  ];
  for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);

  // The export is the other thing a user actually takes away.
  const wb = await buildProofForecastWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  const sheets = wb.worksheets.map((w) => `${w.name} (${w.rowCount} rows)`);
  console.log(`  workbook: ${(buf.byteLength / 1024).toFixed(0)} kB — ${sheets.join(", ")}`);

  const failed = checks.filter(([, ok]) => !ok);
  console.log(failed.length ? `\n  ${failed.length} CHECK(S) FAILED` : `\n  All render checks passed.`);
  await prisma.$disconnect();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
