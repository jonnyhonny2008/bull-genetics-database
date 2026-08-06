import "server-only";

// ---------------------------------------------------------------------------
// Proof Round Comparison report → a single self-contained HTML file.
//
// No external assets, no JavaScript. The three-way population toggle is pure CSS
// (hidden radio inputs + `:checked ~ sibling` selectors), so it works when the
// file is saved and opened locally — where browsers block file:// script.
//
// Every bull name / value goes through esc(), so a name like `<b>` renders as
// text in a mail client rather than as markup.
// ---------------------------------------------------------------------------

import type {
  RoundReport, TierBlock, TierAverages, MoveRow, FullRow, NewcomerRow, RoundValues,
} from "./proof-round-report";
import { ROUND_TRAITS } from "./proof-round-report";
import { BLONDIN_LOGO_DATA_URI } from "./report-logo";

// --- primitives -------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Value formatter: whole numbers for the big indexes, 1 dp for the small ones. */
function fmt(n: number | null | undefined, dp?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const d = dp ?? (Math.abs(n) >= 100 ? 0 : 1);
  const r = Number(n.toFixed(d));
  return r.toLocaleString("en-CA");
}

/** A signed, coloured change cell. Green up, red down, grey nil. */
function change(n: number | null | undefined, dp?: number): string {
  if (n == null || !Number.isFinite(n)) return `<span class="nil">—</span>`;
  const cls = n > 0 ? "up" : n < 0 ? "down" : "nil";
  const sign = n > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${fmt(n, dp)}</span>`;
}

const nameCell = (name: string, url: string | null): string =>
  url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name);

// --- average boxes ----------------------------------------------------------

function avgRow(label: string, a: TierAverages): string {
  const boxes = [
    { label: "LPI", v: a.lpi },
    { label: "Milk kg", v: a.milk },
    { label: "Fat kg", v: a.fat },
    { label: "Protein kg", v: a.prot },
    { label: "Conformation", v: a.conf },
  ].map((b) => {
    const cls = b.v == null ? "nil" : b.v > 0 ? "up" : b.v < 0 ? "down" : "nil";
    const sign = b.v != null && b.v > 0 ? "+" : "";
    return `<div class="box"><div class="boxnum ${cls}">${b.v == null ? "—" : sign + fmt(b.v, 1)}</div><div class="boxlbl">${esc(b.label)}</div></div>`;
  }).join("");
  return `<div class="avgrow"><div class="avglabel">${esc(label)}</div><div class="boxes">${boxes}</div><div class="avgn">${a.n} of ${a.population} bulls moved</div></div>`;
}

// --- movers (gainers / losers) ---------------------------------------------

function moverTable(title: string, rows: MoveRow[], fromLabel: string, toLabel: string): string {
  const body = rows.length
    ? rows.map((r, i) => `<tr>
        <td class="rk">${i + 1}</td>
        <td>${nameCell(r.name, r.profileUrl)}</td>
        <td class="mono">${esc(r.naab ?? "—")}</td>
        <td class="al-r">${fmt(r.from)}</td>
        <td class="al-r">${fmt(r.to)}</td>
        <td class="al-r">${change(r.change)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">None in this population.</td></tr>`;
  return `<div class="mover">
    <div class="movertitle">${esc(title)}</div>
    <table><thead><tr><th>#</th><th>Name</th><th>NAAB</th><th class="al-r">${esc(fromLabel)}</th><th class="al-r">${esc(toLabel)}</th><th class="al-r">Change</th></tr></thead>
    <tbody>${body}</tbody></table>
  </div>`;
}

// --- one tier's toggle-body -------------------------------------------------

function tierBody(t: TierBlock, r: RoundReport): string {
  const fl = esc(r.fromRun), tl = esc(r.toRun);
  return `<div class="tierbody" data-tier="${t.key}">
    <div class="card">
      ${avgRow(`By LPI Rank — ${esc(t.label)}`, t.byLpi)}
      ${avgRow(`By Conformation Rank — ${esc(t.label)}`, t.byConf)}
    </div>

    <h3 class="sec">LPI Gainers &amp; Losers</h3>
    <div class="twocol">
      ${moverTable("▲ Top 10 LPI Gainers", t.lpiGainers, r.fromRun, r.toRun)}
      ${moverTable("▼ Top 10 LPI Losers", t.lpiLosers, r.fromRun, r.toRun)}
    </div>

    <h3 class="sec">Conformation Gainers &amp; Losers</h3>
    <div class="twocol">
      ${moverTable("▲ Top 10 Conformation Gainers", t.confGainers, r.fromRun, r.toRun)}
      ${moverTable("▼ Top 10 Conformation Losers", t.confLosers, r.fromRun, r.toRun)}
    </div>
  </div>`;
}

// --- full Top-100 table -----------------------------------------------------

function fullTable(r: RoundReport): string {
  const head = `
    <tr class="grp">
      <th rowspan="2">#</th><th rowspan="2">Name</th><th rowspan="2">NAAB</th>
      <th colspan="5" class="gA">${esc(r.fromRun)}</th>
      <th colspan="5" class="gB">${esc(r.toRun)}</th>
      <th colspan="5" class="gC">Change</th>
    </tr>
    <tr class="grp2">
      ${ROUND_TRAITS.map((t) => `<th class="al-r gA">${esc(t.label === "Conformation" ? "Conf" : t.label === "Protein" ? "Prot" : t.label)}</th>`).join("")}
      ${ROUND_TRAITS.map((t) => `<th class="al-r gB">${esc(t.label === "Conformation" ? "Conf" : t.label === "Protein" ? "Prot" : t.label)}</th>`).join("")}
      ${ROUND_TRAITS.map((t) => `<th class="al-r gC">${esc(t.label === "Conformation" ? "Conf" : t.label === "Protein" ? "Prot" : t.label)}</th>`).join("")}
    </tr>`;

  const rows = r.full.map((row) => {
    const from = ROUND_TRAITS.map((t) => `<td class="al-r">${fmt(row.from[t.col as keyof RoundValues] as number | null)}</td>`).join("");
    if (!row.to) {
      return `<tr class="gone">
        <td class="rk">${row.rank}</td><td>${nameCell(row.name, row.profileUrl)}</td><td class="mono">${esc(row.naab ?? "—")}</td>
        ${from}
        <td colspan="10" class="miss">Not in ${esc(r.toRun)}</td>
      </tr>`;
    }
    const to = ROUND_TRAITS.map((t) => `<td class="al-r">${fmt(row.to![t.col as keyof RoundValues] as number | null)}</td>`).join("");
    const chg = ROUND_TRAITS.map((t) => {
      const f = row.from[t.col as keyof RoundValues] as number | null;
      const tv = row.to![t.col as keyof RoundValues] as number | null;
      return `<td class="al-r">${f != null && tv != null ? change(tv - f) : `<span class="nil">—</span>`}</td>`;
    }).join("");
    return `<tr><td class="rk">${row.rank}</td><td>${nameCell(row.name, row.profileUrl)}</td><td class="mono">${esc(row.naab ?? "—")}</td>${from}${to}${chg}</tr>`;
  }).join("");

  return `<table class="full"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

// --- EBV-only sections ------------------------------------------------------

function newcomerTable(title: string, rows: NewcomerRow[]): string {
  const body = rows.length
    ? rows.map((r, i) => `<tr>
        <td class="rk">${i + 1}</td><td>${nameCell(r.name, r.profileUrl)}</td><td class="mono">${esc(r.naab ?? "—")}</td>
        <td class="al-r">${fmt(r.lpi)}</td><td class="al-r">${fmt(r.milk)}</td><td class="al-r">${fmt(r.fat)}</td>
        <td class="al-r">${fmt(r.prot)}</td><td class="al-r">${fmt(r.conf)}</td>
        <td class="al-r">${r.rel == null ? "—" : Math.round(r.rel * 100) + "%"}</td>
      </tr>`).join("")
    : `<tr><td colspan="9" class="empty">No bulls received their first daughter proof this round.</td></tr>`;
  return `<div class="card">
    <div class="movertitle">${esc(title)}</div>
    <table><thead><tr><th>#</th><th>Name</th><th>NAAB</th><th class="al-r">LPI</th><th class="al-r">Milk</th><th class="al-r">Fat</th><th class="al-r">Prot</th><th class="al-r">Conf</th><th class="al-r">Rel%</th></tr></thead>
    <tbody>${body}</tbody></table>
  </div>`;
}

function ebvExtras(r: RoundReport): string {
  return `
  <h2 class="sec2">Top 10 Newly Proven — PA in ${esc(r.fromRun)}, Now EBV in ${esc(r.toRun)}</h2>
  <p class="note">These bulls were genomic (PA) in ${esc(r.fromRun)} and received their first daughter proof (EBV) in ${esc(r.toRun)}.</p>
  ${newcomerTable(`Top 10 Newcomers by LPI (${esc(r.toRun)})`, r.newcomersByLpi)}
  ${newcomerTable(`Top 10 Newcomers by Conformation (${esc(r.toRun)})`, r.newcomersByConf)}

  <h2 class="sec2">Newly Proven — Gains &amp; Drops (PA → EBV)</h2>
  <p class="note">${esc(r.fromRun)} values are the bull's genomic (PA) proof; ${esc(r.toRun)} values are their first daughter proof (EBV) — how much the proof moved when real daughter data replaced the genomic estimate.</p>
  <h3 class="sec">LPI Gains &amp; Drops</h3>
  <div class="twocol">
    ${moverTable("▲ Top 10 LPI Gains", r.newProvenLpiGains, r.fromRun, r.toRun)}
    ${moverTable("▼ Bottom 10 LPI Drops", r.newProvenLpiDrops, r.fromRun, r.toRun)}
  </div>
  <h3 class="sec">Conformation Gains &amp; Drops</h3>
  <div class="twocol">
    ${moverTable("▲ Top 10 Conformation Gains", r.newProvenConfGains, r.fromRun, r.toRun)}
    ${moverTable("▼ Bottom 10 Conformation Drops", r.newProvenConfDrops, r.fromRun, r.toRun)}
  </div>`;
}

// --- the document -----------------------------------------------------------

const STYLE = `
:root{--navy:#0f2c40;--navy2:#12384f;--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bg:#f3f4f6;
--up:#15803d;--upbg:#e7f6ec;--down:#b91c1c;--downbg:#fdeaea;--nil:#9ca3af;--card:#ffffff;--accentY:#facc15;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:24px;margin:0 0 2px}
.sub{color:var(--muted);margin:0 0 4px}
.meta{color:var(--muted);font-size:12px;margin:0 0 18px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);padding:16px;margin:0 0 16px}
h2.sec2{font-size:19px;margin:22px 0 4px}
h3.sec{font-size:16px;margin:18px 0 8px;color:var(--navy)}
.note{color:var(--muted);font-size:12.5px;margin:0 0 10px;max-width:900px}
.popnote{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:8px 12px;font-size:12.5px;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{background:var(--navy);color:#fff;font-weight:600;padding:7px 9px;text-align:left;white-space:nowrap}
tbody td{padding:6px 9px;border-bottom:1px solid var(--line)}
tbody tr:nth-child(even){background:#f8fafc}
.al-r{text-align:right}
.rk{color:var(--muted);text-align:center;width:30px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#475569}
.up{color:var(--up);font-weight:700}.down{color:var(--down);font-weight:700}.nil{color:var(--nil)}
a{color:var(--navy2);text-decoration:none}a:hover{text-decoration:underline}
.empty{color:var(--muted);text-align:center;font-style:italic}
/* average boxes */
.avgrow{margin:0 0 12px}
.avgrow:last-child{margin:0}
.avglabel{font-weight:600;font-size:13px;color:var(--navy);margin:0 0 6px}
.avgn{color:var(--muted);font-size:11px;margin-top:5px}
.boxes{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.box{background:#f8fafc;border:1px solid var(--line);border-radius:9px;padding:12px 8px;text-align:center}
.boxnum{font-size:22px;font-weight:800;line-height:1.1}
.boxlbl{color:var(--muted);font-size:11px;margin-top:3px}
/* toggle (pure CSS) */
.tiersel{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.toggle{display:inline-flex;background:#e2e8f0;border-radius:999px;padding:4px;gap:2px;margin:0 0 16px}
.toggle label{cursor:pointer;padding:7px 18px;border-radius:999px;font-weight:600;font-size:13px;color:#475569;user-select:none}
.tierbody{display:none}
#tsel-all:checked~.toggle label[for="tsel-all"],
#tsel-top1000:checked~.toggle label[for="tsel-top1000"],
#tsel-top200:checked~.toggle label[for="tsel-top200"]{background:var(--navy);color:#fff}
#tsel-all:checked~.tierbody[data-tier="all"],
#tsel-top1000:checked~.tierbody[data-tier="top1000"],
#tsel-top200:checked~.tierbody[data-tier="top200"]{display:block}
/* two-column movers */
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.mover{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
.movertitle{background:var(--navy2);color:#fff;font-weight:600;padding:9px 12px;font-size:13px}
.mover table thead th{background:#1e4b66}
/* full table */
.full{background:var(--card);border-radius:10px;overflow:hidden}
.full .gA{background:#123a52}.full .gB{background:#0f2c40}.full .gC{background:#7c5e00}
.full thead .gC{color:var(--accentY)}
.full tr.gone td{color:var(--nil);background:#f9fafb}
.full .miss{color:var(--nil);font-style:italic;text-align:center}
.tablewrap{overflow-x:auto}
@media(max-width:900px){.boxes{grid-template-columns:repeat(2,1fr)}.twocol{grid-template-columns:1fr}}
`;

export function roundReportHtml(r: RoundReport): string {
  const popNote = `This dataset holds the <strong>NAAB-coded Holstein bulls</strong> in the database — ${r.fromCount} in ${esc(r.fromRun)} and ${r.toCount} in ${esc(r.toRun)} (${r.universe} across both), not the full Canadian breed. "Top 1,000" therefore shows the whole lineup; the population tiers are ranked by ${esc(r.toRun)} standings so "Top 200" is a genuine subset.`;

  const toggle = `
  <input type="radio" name="tiersel" id="tsel-all" class="tiersel" checked>
  <input type="radio" name="tiersel" id="tsel-top1000" class="tiersel">
  <input type="radio" name="tiersel" id="tsel-top200" class="tiersel">
  <div class="toggle">
    <label for="tsel-all">All Breed</label>
    <label for="tsel-top1000">Top 1,000</label>
    <label for="tsel-top200">Top 200</label>
  </div>
  ${r.tiers.map((t) => tierBody(t, r)).join("\n")}`;

  const fullTitle = r.type === "ebv"
    ? `Top ${Math.min(100, r.fullAvailable)} Canadian Daughter-Proven (EBV) Bulls — ${esc(r.fromRun)} vs ${esc(r.toRun)}`
    : `Top ${Math.min(100, r.fullAvailable)} PA Bulls (Genomic) — ${esc(r.fromRun)} vs ${esc(r.toRun)}`;
  const fullNote = r.fullAvailable < 100
    ? `<p class="note">${r.fullAvailable} ${r.type === "ebv" ? "daughter-proven (EBV)" : "genomic (PA)"} NAAB Holstein bull${r.fullAvailable === 1 ? "" : "s"} were on file in ${esc(r.fromRun)} — fewer than 100, so all are shown.</p>`
    : "";

  const body = `
  <div class="wrap">
    <img src="${BLONDIN_LOGO_DATA_URI}" alt="Blondin Sires" style="height:40px;margin:0 0 10px">
    <h1>${esc(r.title)}</h1>
    <p class="sub">${esc(r.subtitle)}</p>
    <p class="meta">Generated ${esc(new Date(r.generatedAt).toISOString().slice(0, 10))} · Canadian Holstein · NAAB stud codes only</p>

    ${r.type === "ebv" ? ebvExtras(r) : ""}

    <h2 class="sec2">Proof Change Summary — ${esc(r.fromRun)} → ${esc(r.toRun)}</h2>
    <div class="popnote">${popNote}</div>
    ${toggle}

    <h2 class="sec2">${fullTitle}</h2>
    ${fullNote}
    <div class="card"><div class="tablewrap">${fullTable(r)}</div></div>
  </div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}
