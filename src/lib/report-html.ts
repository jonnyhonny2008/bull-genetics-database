// ---------------------------------------------------------------------------
// SELF-CONTAINED HTML REPORT EMITTER
//
// Every report gains a second export beside its Excel workbook: ONE .html file
// that can be attached to an email. The recipient opens it from file://, with no
// network, and sees the report as it appears in the app — and can still sort,
// filter, expand rows and switch views.
//
// THE RULES THIS MODULE EXISTS TO ENFORCE
//
// 1. NO EXTERNAL REFERENCES OF ANY KIND. No CDN, no webfont URL, no <img src>
//    pointing at a server, no fetch/XHR, no ES module import. One inline
//    <style>, one inline <script>, system fonts, and the logo as a data: URI.
//    report-html.test.ts asserts the emitted document contains no http:// or
//    https:// anywhere, which is the only version of this rule that stays true.
//
// 2. ESCAPE EVERYTHING. Every string that reaches this file came from the
//    database or from what a user pasted into the female box: bull names, cow
//    names, registration numbers, notes, warnings. A bull named
//    <script>alert(1)</script> MUST render as visible text in the recipient's
//    mail client. `esc()` is the only way a value may become markup, and the
//    cell/badge/stat builders below all funnel through it. An unescaped path is
//    a defect even when today's data happens to be clean.
//
// 3. NO PRISMA IMPORT. This module is pure string work, so the escaping can be
//    unit tested with `tsx --test` without a database. Section builders take the
//    already-built report OBJECT — the same one the page and the workbook use,
//    so the numbers cannot drift.
//
// The stylesheet is hand-authored rather than Tailwind's compiled output: the
// app's classes only mean anything alongside the generated stylesheet, which is
// far too large to inline. It is written in the same design language and off the
// same palette (tailwind.config.ts brand-* teal, navy-*, accent orange).
// ---------------------------------------------------------------------------

import { BLONDIN_LOGO_DATA_URI } from "./report-logo";

// --- escaping ---------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * The single escape used for ALL untrusted text, in element bodies and inside
 * attribute values alike.
 *
 * Both quote characters are escaped, not just the double quote, so the same
 * function is correct in `class="…"`, in `title='…'`, and in an unquoted
 * attribute. `&` goes first by virtue of being in the same character class —
 * the regex makes a single pass, so an already-escaped entity cannot be
 * double-escaped by a second run over the same substring.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * JSON for embedding inside the inline <script> block.
 *
 * JSON.stringify alone is NOT safe here. A bull named `</script><img onerror=…>`
 * produces a literal `</script>` inside the script element, and the HTML parser
 * ends the script at that point — before any JavaScript string rules apply. The
 * closing angle bracket is what does it, so `<` and `>` are escaped to their
 * \\u form (still the same string once JSON.parse/JS runs, so nothing is lost).
 * `&` is escaped for the same reason inside an HTML-escaping context, and
 * U+2028/U+2029 because they are literal line terminators in JS source.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    // \u escapes in the PATTERN, never the literal characters: U+2028/U+2029 are
    // line terminators in JS source too, so a literal one inside /…/ is an
    // unterminated-regex parse error — the very bug this line prevents one level down.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// --- shared value formatting ------------------------------------------------
// These mirror what the report tables show on screen. Where the page uses a
// formatter from ./format, the section builders import that one directly rather
// than re-implementing it here.

/** At most 2 decimals, trailing zeros dropped — the tables' `fmt`. */
export const num2 = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : String(Math.round(n * 100) / 100);

/** Same, with an explicit + on positives — the tables' `signed`. */
export const signed = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}`;

/** A 0-1 fraction as a whole percent — the tables' `pct`. */
export const pct01 = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : `${Math.round(n * 100)}%`;

/** Thousands separators, matching fmtNum's en-CA grouping. */
export const int = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toLocaleString("en-CA", { maximumFractionDigits: 0 });

/** Direction colour class, matching the app: green up, red down, grey flat. */
export function deltaClass(d: number | null | undefined): string {
  if (d === null || d === undefined || d === 0 || Number.isNaN(d)) return "flat";
  return d > 0 ? "up" : "down";
}

/** ▲ / ▼ / nothing, matching the app's change tables. */
export function arrow(d: number | null | undefined): string {
  if (d === null || d === undefined || d === 0 || Number.isNaN(d)) return "";
  return d > 0 ? "▲" : "▼";
}

// --- size caps --------------------------------------------------------------

/**
 * Cap a list and SAY SO — never silently truncate.
 *
 * A 50-female mating run against the whole 945-bull database produces tens of
 * thousands of exclusion records, and this file is an email attachment against
 * a limit commonly near 25 MB. So long lists are cut, but the true count always
 * survives and the cut is stated in the file itself, at the place it bit.
 */
export interface Capped<T> {
  items: T[];
  total: number;
  capped: boolean;
  /** Ready-to-render sentence, already escaped. "" when the cap did not bite. */
  note: string;
}

export function cap<T>(items: T[], max: number, noun: string, qualifier = ""): Capped<T> {
  const total = items.length;
  if (total <= max) return { items, total, capped: false, note: "" };
  const q = qualifier ? `${qualifier} ` : "";
  return {
    items: items.slice(0, max),
    total,
    capped: true,
    note: esc(`Showing the ${q}${int(max)} ${noun} of ${int(total)} — the rest are in the Excel export, which is not capped.`),
  };
}

// --- small builders ---------------------------------------------------------

export type Tone = "default" | "good" | "warn" | "danger" | "accent" | "info" | "muted";

/** A tier / flag pill, in the app's badge vocabulary. */
export function badge(text: string, tone: Tone = "default"): string {
  return `<span class="badge badge-${esc(tone)}">${esc(text)}</span>`;
}

export interface Stat {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
}

/** The StatCard summary strip from the top of every report page. */
export function statStrip(stats: Stat[]): string {
  if (!stats.length) return "";
  const cards = stats
    .map(
      (s) => `<div class="stat stat-${esc(s.tone ?? "default")}">
      <div class="stat-bar"></div>
      <div class="stat-body">
        <div class="stat-label">${esc(s.label)}</div>
        <div class="stat-value">${esc(s.value)}</div>
        ${s.hint ? `<div class="stat-hint">${esc(s.hint)}</div>` : ""}
      </div>
    </div>`,
    )
    .join("");
  return `<div class="stats">${cards}</div>`;
}

/** A coloured callout — the amber/red/navy notice bars the pages carry. */
export function notice(text: string, tone: Tone = "warn"): string {
  return `<div class="notice notice-${esc(tone)}">${esc(text)}</div>`;
}

/**
 * A callout whose body is ALREADY-BUILT HTML.
 *
 * The name is the warning: everything passed here must have gone through esc()
 * or be a literal in our own source. It exists for the few fixed disclaimers
 * that need <strong> inside them, never for data.
 */
export function noticeHtml(html: string, tone: Tone = "warn"): string {
  return `<div class="notice notice-${esc(tone)}">${html}</div>`;
}

export function section(title: string, bodyHtml: string, subtitle?: string): string {
  return `<section class="card">
    <div class="card-head">
      <h2>${esc(title)}</h2>
      ${subtitle ? `<p class="card-sub">${esc(subtitle)}</p>` : ""}
    </div>
    <div class="card-body">${bodyHtml}</div>
  </section>`;
}

/** A collapsed disclosure — native <details>, so it works with JS disabled and
 *  the print hook can force it open. */
export function disclosure(summary: string, bodyHtml: string, open = false): string {
  return `<details class="disc"${open ? " open" : ""}>
    <summary>${esc(summary)}</summary>
    <div class="disc-body">${bodyHtml}</div>
  </details>`;
}

// --- tables -----------------------------------------------------------------

export interface Column {
  label: string;
  /** How a click on this header sorts. "none" makes the header inert. */
  sort?: "num" | "text" | "none";
  align?: "left" | "right" | "center";
  /** Tooltip, shown as title=. Escaped. */
  title?: string;
  /** Fixed width hint, e.g. "12ch". Emitted as an inline style; keep it literal. */
  width?: string;
}

export interface Cell {
  /** Already-escaped HTML for the cell body. Build it with esc()/badge()/num2(). */
  html: string;
  /**
   * What a sort compares. A number sorts numerically — which is the whole point
   * of carrying it separately, because "100" sorts before "20" as text. null or
   * undefined always sorts LAST, in either direction, so a missing value never
   * masquerades as a small one.
   */
  sort?: number | string | null;
  className?: string;
  /** Tooltip on the cell. Escaped here. */
  title?: string;
}

export interface Row {
  cells: Cell[];
  /** Detail panel revealed by clicking the row. Already-escaped HTML. */
  detail?: string;
  className?: string;
}

export interface TableSpec {
  columns: Column[];
  rows: Row[];
  /** Extra classes on the <table>. */
  className?: string;
  /** Shown in place of the table when there are no rows. */
  empty?: string;
  /** Row text is matched against the filter box when true (the default). */
  filterable?: boolean;
}

/** Plain text of a cell, for the filter box to match on. */
function cellText(c: Cell): string {
  return c.html.replace(/<[^>]*>/g, " ").replace(/&[a-z0-9#]+;/gi, " ");
}

export function table(spec: TableSpec): string {
  const { columns, rows } = spec;
  if (!rows.length && spec.empty) return `<p class="empty">${esc(spec.empty)}</p>`;

  const expandable = rows.some((r) => r.detail);
  const span = columns.length + (expandable ? 1 : 0);

  const head = columns
    .map((c) => {
      const sort = c.sort ?? "text";
      const align = c.align ?? "left";
      const attrs = [
        `class="al-${esc(align)}${sort === "none" ? "" : " sortable"}"`,
        sort === "none" ? "" : `data-sort="${esc(sort)}"`,
        c.title ? `title="${esc(c.title)}"` : "",
        c.width ? `style="width:${esc(c.width)}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<th ${attrs}><span class="th-label">${esc(c.label)}</span><span class="caret"></span></th>`;
    })
    .join("");

  const body = rows
    .map((r, i) => {
      const filterText = spec.filterable === false ? "" : r.cells.map(cellText).join(" ");
      const tds = r.cells
        .map((c, ci) => {
          const col = columns[ci];
          const align = col?.align ?? "left";
          const sortAttr =
            c.sort === null || c.sort === undefined
              ? ""
              : ` data-sv="${esc(c.sort)}"${typeof c.sort === "number" ? "" : ""}`;
          const cls = `al-${align}${c.className ? ` ${esc(c.className)}` : ""}`;
          return `<td class="${cls}"${sortAttr}${c.title ? ` title="${esc(c.title)}"` : ""}>${c.html}</td>`;
        })
        .join("");
      const toggle = expandable
        ? `<td class="al-right toggle">${r.detail ? '<span class="chev">▼</span>' : ""}</td>`
        : "";
      const rowCls = [r.className, r.detail ? "expandable" : ""].filter(Boolean).join(" ");
      const main = `<tr class="${esc(rowCls)}" data-row="${i}"${
        spec.filterable === false ? "" : ` data-t="${esc(filterText.toLowerCase())}"`
      }${r.detail ? ` data-toggle="${i}"` : ""}>${tds}${toggle}</tr>`;
      const detail = r.detail
        ? `<tr class="detail" data-detail="${i}" hidden><td colspan="${span}"><div class="detail-body">${r.detail}</div></td></tr>`
        : "";
      return main + detail;
    })
    .join("");

  return `<div class="tw"><table class="tbl${spec.className ? ` ${esc(spec.className)}` : ""}">
    <thead><tr>${head}${expandable ? "<th></th>" : ""}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/**
 * The compact "one line per trait" grid the expanded panels use in the app.
 * Every field is escaped by its caller's use of the formatters above; `name`
 * is data and is escaped here.
 */
export function traitLines(
  lines: { lead: string; leadClass?: string; name: string; keyTrait?: boolean; mid?: string; right?: string; rightClass?: string; highlight?: boolean }[],
): string {
  if (!lines.length) return `<p class="empty">None.</p>`;
  return `<div class="tlines">${lines
    .map(
      (l) => `<div class="tline${l.highlight ? " hl" : l.keyTrait ? " keyrow" : ""}">
      <span class="tl-lead ${esc(l.leadClass ?? "")}">${esc(l.lead)}</span>
      <span class="tl-name">${esc(l.name)}${l.keyTrait ? '<span class="keytag">key</span>' : ""}</span>
      <span class="tl-mid">${esc(l.mid ?? "")}</span>
      <span class="tl-right ${esc(l.rightClass ?? "")}">${esc(l.right ?? "")}</span>
    </div>`,
    )
    .join("")}</div>`;
}

// --- the document shell -----------------------------------------------------

export interface DocumentSpec {
  /** Browser tab / <title>. */
  docTitle: string;
  /** The report's name, as the page shows it. */
  reportTitle: string;
  /** One line saying what the report is. */
  subtitle: string;
  /**
   * The run parameters IN PLAIN WORDS, so a recipient months later knows what
   * they are looking at. "Blondin bulls only", not "blondin=1".
   */
  params: { label: string; value: string }[];
  generatedAt: Date;
  stats?: Stat[];
  /** Callouts above the content — already-built HTML from notice()/noticeHtml(). */
  notices?: string[];
  /** The report body — already-built HTML from section()/table(). */
  sections: string[];
  /** The caveats the page carries. Plain text; escaped here. */
  footnotes: string[];
  /** Extra buttons beside the filter box, e.g. the mating report's view switch. */
  toolbarHtml?: string;
}

function formatGeneratedAt(d: Date): string {
  // Fixed, unambiguous, and locale-independent — the recipient may be anywhere
  // and the file may be read months later.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function htmlDocument(spec: DocumentSpec): string {
  const generated = formatGeneratedAt(spec.generatedAt);

  // Embedded for the script: the counter label and the document's own identity.
  // Values here are report metadata and bull/cow-derived strings, so it goes
  // through jsonForScript — a `</script>` in any of them must not end the block.
  const meta = {
    title: spec.reportTitle,
    generated,
    params: spec.params,
  };

  const paramRows = spec.params
    .map((p) => `<div class="param"><dt>${esc(p.label)}</dt><dd>${esc(p.value)}</dd></div>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Blondin Sires — Bull Stud Genetics Platform">
<title>${esc(spec.docTitle)}</title>
<style>${STYLESHEET}</style>
</head>
<body>
<div class="wrap">

  <header class="doc-head">
    <img class="logo" alt="Blondin Sires" src="${BLONDIN_LOGO_DATA_URI}">
    <div class="doc-title">
      <h1>${esc(spec.reportTitle)}</h1>
      <div class="accent-bar"></div>
      <p class="doc-sub">${esc(spec.subtitle)}</p>
    </div>
    <div class="doc-when">
      <div class="when-label">Generated</div>
      <div class="when-value">${esc(generated)}</div>
    </div>
  </header>

  <dl class="params">${paramRows}</dl>

  ${(spec.notices ?? []).join("\n")}

  ${spec.stats && spec.stats.length ? statStrip(spec.stats) : ""}

  <div class="toolbar no-print">
    <label class="filter">
      <span class="filter-icon" aria-hidden="true">⌕</span>
      <input type="search" id="q" placeholder="Filter rows — type a name, NAAB or registration" autocomplete="off">
    </label>
    <span class="count" id="count"></span>
    ${spec.toolbarHtml ?? ""}
    <button type="button" class="btn btn-ghost" id="expand-all">Expand all</button>
    <button type="button" class="btn btn-ghost" id="print">Print</button>
  </div>

  <main id="report">
${spec.sections.join("\n")}
  </main>

  <footer class="doc-foot">
    <div class="foot-brand">
      <strong>Blondin Sires</strong> · Bull Stud Genetics Platform
    </div>
    <ul class="caveats">
      ${spec.footnotes.map((f) => `<li>${esc(f)}</li>`).join("\n      ")}
      <li>This file is a snapshot generated at ${esc(
        generated,
      )}. Proofs move: a copy read months later is a record of what was on file that day, not a current evaluation.</li>
      <li>Styling here is a compact hand-authored stylesheet in the app's design language, not the application's own compiled stylesheet — so this file can stand alone with no network. The numbers are the application's, unchanged.</li>
    </ul>
  </footer>

</div>
<script>
(function () {
  "use strict";
  var META = ${jsonForScript(meta)};
  var root = document.getElementById("report");
  if (!root) return;

  // --- sorting -------------------------------------------------------------
  // A numeric column sorts NUMERICALLY: "100" must not sort before "20". The
  // comparable value is data-sv on the cell when present, the cell's text
  // otherwise. A missing value sorts last in BOTH directions, so an empty cell
  // never masquerades as a small number.
  function cellValue(row, i, kind) {
    var td = row.children[i];
    if (!td) return null;
    var raw = td.hasAttribute("data-sv") ? td.getAttribute("data-sv") : td.textContent;
    if (raw == null) return null;
    raw = String(raw).trim();
    if (raw === "" || raw === "\\u2014") return null;
    if (kind === "num") {
      var n = parseFloat(raw.replace(/[, ]/g, "").replace(/[^0-9eE+.\\-]/g, ""));
      return isNaN(n) ? null : n;
    }
    return raw.toLowerCase();
  }

  function sortTable(table, index, kind, dir) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    // Rows travel as (main, detail) pairs so an expanded panel stays with its bull.
    var groups = [];
    var kids = Array.prototype.slice.call(tbody.children);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList.contains("detail")) continue;
      var pair = [kids[i]];
      if (kids[i + 1] && kids[i + 1].classList.contains("detail")) pair.push(kids[i + 1]);
      groups.push(pair);
    }
    var decorated = groups.map(function (g, i) {
      return { g: g, v: cellValue(g[0], index, kind), i: i };
    });
    decorated.sort(function (a, b) {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      var c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      if (c === 0) return a.i - b.i;
      return dir === "asc" ? c : -c;
    });
    var frag = document.createDocumentFragment();
    decorated.forEach(function (d) {
      d.g.forEach(function (r) { frag.appendChild(r); });
    });
    tbody.appendChild(frag);
  }

  root.addEventListener("click", function (e) {
    var th = e.target.closest ? e.target.closest("th.sortable") : null;
    if (!th) return;
    var table = th.closest("table");
    var head = th.parentNode;
    var index = Array.prototype.indexOf.call(head.children, th);
    var dir = th.getAttribute("data-dir") === "asc" ? "desc" : "asc";
    Array.prototype.forEach.call(head.children, function (o) {
      o.removeAttribute("data-dir");
      o.classList.remove("sorted");
    });
    th.setAttribute("data-dir", dir);
    th.classList.add("sorted");
    sortTable(table, index, th.getAttribute("data-sort") || "text", dir);
  });

  // --- expandable detail rows ---------------------------------------------
  root.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("th")) return;
    var tr = e.target.closest ? e.target.closest("tr[data-toggle]") : null;
    if (!tr) return;
    var tbody = tr.parentNode;
    var id = tr.getAttribute("data-toggle");
    var detail = tbody.querySelector('tr[data-detail="' + id + '"]');
    if (!detail) return;
    var show = detail.hasAttribute("hidden");
    if (show) detail.removeAttribute("hidden"); else detail.setAttribute("hidden", "");
    tr.classList.toggle("open", show);
    var chev = tr.querySelector(".chev");
    if (chev) chev.textContent = show ? "\\u25B2" : "\\u25BC";
  });

  // --- view switch (mating report: herd summary / per female) --------------
  var switches = document.querySelectorAll("[data-view-btn]");
  Array.prototype.forEach.call(switches, function (btn) {
    btn.addEventListener("click", function () {
      var want = btn.getAttribute("data-view-btn");
      Array.prototype.forEach.call(switches, function (o) {
        o.classList.toggle("btn-primary", o === btn);
        o.classList.toggle("btn-ghost", o !== btn);
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (p) {
        p.hidden = p.getAttribute("data-view") !== want;
      });
      applyFilter();
    });
  });

  // --- text filter ---------------------------------------------------------
  var q = document.getElementById("q");
  var countEl = document.getElementById("count");

  function applyFilter() {
    var term = (q && q.value ? q.value : "").trim().toLowerCase();
    var shown = 0;
    var total = 0;
    var rows = root.querySelectorAll("tr[data-t]");
    Array.prototype.forEach.call(rows, function (tr) {
      // Rows in a hidden view are not part of the count — the counter must
      // describe what the reader can actually see.
      var panel = tr.closest("[data-view]");
      if (panel && panel.hidden) return;
      total++;
      var hit = !term || tr.getAttribute("data-t").indexOf(term) !== -1;
      tr.hidden = !hit;
      if (hit) shown++;
      var id = tr.getAttribute("data-toggle");
      if (id !== null) {
        var d = tr.parentNode.querySelector('tr[data-detail="' + id + '"]');
        // A filtered-out row hides its panel too, but re-showing must not
        // silently re-open a panel the reader had closed.
        if (d && !hit) d.hidden = true;
        else if (d && hit && !tr.classList.contains("open")) d.hidden = true;
        else if (d && hit && tr.classList.contains("open")) d.hidden = false;
      }
    });
    // A female card with nothing left in it is noise, so it folds away too.
    Array.prototype.forEach.call(root.querySelectorAll("[data-card]"), function (card) {
      var any = card.querySelector("tr[data-t]:not([hidden])");
      card.hidden = !!term && !any;
    });
    if (countEl) {
      countEl.textContent = term
        ? shown + " of " + total + " rows match"
        : total + (total === 1 ? " row" : " rows");
    }
  }

  if (q) {
    q.addEventListener("input", applyFilter);
    // Escape clears, which is what every filter box in the app does.
    q.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { q.value = ""; applyFilter(); }
    });
  }
  applyFilter();

  // --- expand all / print --------------------------------------------------
  var expandAll = document.getElementById("expand-all");
  var expanded = false;
  function setAll(open) {
    Array.prototype.forEach.call(root.querySelectorAll("tr[data-detail]"), function (d) {
      if (open) d.removeAttribute("hidden"); else d.setAttribute("hidden", "");
    });
    Array.prototype.forEach.call(root.querySelectorAll("tr[data-toggle]"), function (t) {
      t.classList.toggle("open", open);
      var c = t.querySelector(".chev");
      if (c) c.textContent = open ? "\\u25B2" : "\\u25BC";
    });
    Array.prototype.forEach.call(root.querySelectorAll("details"), function (d) { d.open = open; });
    if (open) applyFilter();
  }
  if (expandAll) {
    expandAll.addEventListener("click", function () {
      expanded = !expanded;
      setAll(expanded);
      expandAll.textContent = expanded ? "Collapse all" : "Expand all";
    });
  }

  // Print with everything open. CSS alone cannot force a closed <details> to
  // render its body, so the state is opened for the print and put back after.
  var restore = null;
  function beforePrint() {
    restore = {
      details: Array.prototype.map.call(root.querySelectorAll("details"), function (d) { return d.open; }),
      rows: Array.prototype.map.call(root.querySelectorAll("tr[data-detail]"), function (d) { return d.hasAttribute("hidden"); }),
      views: Array.prototype.map.call(root.querySelectorAll("[data-view]"), function (v) { return v.hidden; })
    };
    Array.prototype.forEach.call(root.querySelectorAll("details"), function (d) { d.open = true; });
    Array.prototype.forEach.call(root.querySelectorAll("tr[data-detail]"), function (d) {
      if (d.previousElementSibling && !d.previousElementSibling.hidden) d.removeAttribute("hidden");
    });
  }
  function afterPrint() {
    if (!restore) return;
    Array.prototype.forEach.call(root.querySelectorAll("details"), function (d, i) { d.open = restore.details[i]; });
    Array.prototype.forEach.call(root.querySelectorAll("tr[data-detail]"), function (d, i) {
      if (restore.rows[i]) d.setAttribute("hidden", ""); else d.removeAttribute("hidden");
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-view]"), function (v, i) { v.hidden = restore.views[i]; });
    restore = null;
  }
  if (window.matchMedia) {
    var mql = window.matchMedia("print");
    if (mql.addEventListener) mql.addEventListener("change", function (m) { if (m.matches) beforePrint(); else afterPrint(); });
  }
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);

  var printBtn = document.getElementById("print");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  if (META && META.title) document.documentElement.setAttribute("data-report", META.title);
})();
</script>
</body>
</html>
`;
}

// --- the stylesheet ---------------------------------------------------------
// Hand-authored, in the app's design language, off the tailwind.config.ts
// palette: brand-* turquoise (#1abc9c / #16a085), navy-* chrome (#2c3e50), and
// accent orange (#e67e22). System fonts only — a webfont URL would be a network
// reference, which this file must not contain.

const STYLESHEET = `
:root{
  --brand-50:#e8f8f5; --brand-100:#d0ece7; --brand-200:#a2d9ce; --brand-500:#1abc9c;
  --brand-600:#16a085; --brand-700:#128f76; --brand-900:#0b5f4e;
  --navy-50:#f4f6f7; --navy-100:#e5e8eb; --navy-200:#c8ced5; --navy-300:#9aa5b1;
  --navy-400:#5d6d7e; --navy-600:#34495e; --navy-700:#2c3e50; --navy-900:#1f2d3a;
  --accent-500:#e67e22; --accent-600:#ca6f1e; --accent-50:#fdf2e9;
  --up:#059669; --up-bg:#ecfdf5; --down:#dc2626; --down-bg:#fef2f2;
  --amber:#b45309; --amber-bg:#fffbeb; --amber-bd:#fcd34d;
  --slate-50:#f8fafc; --slate-100:#f1f5f9; --slate-200:#e2e8f0; --slate-300:#cbd5e1;
  --slate-400:#94a3b8; --slate-500:#64748b; --slate-600:#475569; --slate-800:#1e293b;
  --radius:8px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  font-size:14px; line-height:1.45; color:var(--slate-800); background:var(--navy-50);
  -webkit-text-size-adjust:100%;
}
.wrap{max-width:1360px;margin:0 auto;padding:20px 18px 56px}

/* --- header --- */
.doc-head{display:flex;flex-wrap:wrap;align-items:center;gap:16px;
  background:linear-gradient(135deg,var(--navy-700),var(--navy-900));
  color:#fff;border-radius:var(--radius);padding:16px 20px;margin-bottom:14px}
.logo{height:46px;width:auto;flex:none;background:#fff;border-radius:6px;padding:5px}
.doc-title{flex:1 1 320px;min-width:0}
.doc-title h1{margin:0;font-size:21px;font-weight:700;letter-spacing:-.01em}
.accent-bar{width:52px;height:3px;border-radius:2px;background:var(--brand-500);margin:7px 0 6px}
.doc-sub{margin:0;font-size:12.5px;color:var(--navy-200);line-height:1.5}
.doc-when{flex:none;text-align:right}
.when-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--navy-300)}
.when-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}

/* --- run parameters --- */
.params{display:flex;flex-wrap:wrap;gap:0;margin:0 0 14px;padding:10px 4px;
  background:#fff;border:1px solid var(--slate-200);border-radius:var(--radius)}
.param{padding:3px 14px;border-left:3px solid var(--brand-100);margin:3px 0;min-width:150px}
.param dt{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--slate-400);margin:0}
.param dd{margin:1px 0 0;font-size:12.5px;font-weight:600;color:var(--navy-700)}

/* --- notices --- */
.notice{border-radius:6px;padding:9px 12px;margin:0 0 10px;font-size:12px;line-height:1.55;border:1px solid}
.notice strong{font-weight:700}
.notice-warn{background:var(--amber-bg);border-color:var(--amber-bd);color:var(--amber)}
.notice-danger{background:var(--down-bg);border-color:#fca5a5;color:#991b1b}
.notice-info,.notice-default{background:var(--navy-50);border-color:var(--navy-200);color:var(--navy-900)}
.notice-good{background:var(--brand-50);border-color:var(--brand-200);color:var(--brand-900)}
.notice-accent{background:var(--accent-50);border-color:#f5cba7;color:var(--accent-600)}
.notice-muted{background:var(--slate-50);border-color:var(--slate-200);color:var(--slate-600)}

/* --- stat strip --- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
.stat{background:#fff;border:1px solid var(--slate-200);border-radius:var(--radius);overflow:hidden}
.stat-bar{height:3px;background:var(--brand-500)}
.stat-warn .stat-bar{background:#fbbf24}
.stat-danger .stat-bar{background:#ef4444}
.stat-accent .stat-bar{background:var(--accent-500)}
.stat-body{padding:8px 12px 10px}
.stat-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--slate-500)}
.stat-value{font-size:21px;font-weight:700;color:var(--navy-900);font-variant-numeric:tabular-nums;line-height:1.2}
.stat-good .stat-value{color:var(--brand-700)}
.stat-warn .stat-value{color:#b45309}
.stat-danger .stat-value{color:#dc2626}
.stat-accent .stat-value{color:var(--accent-600)}
.stat-hint{font-size:10.5px;color:var(--slate-400);margin-top:1px}

/* --- toolbar --- */
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px;
  background:#fff;border:1px solid var(--slate-200);border-radius:var(--radius);padding:8px 10px}
.filter{display:flex;align-items:center;gap:6px;flex:1 1 260px;
  border:1px solid var(--slate-300);border-radius:6px;padding:4px 9px;background:#fff}
.filter:focus-within{border-color:var(--brand-500);box-shadow:0 0 0 2px var(--brand-100)}
.filter-icon{color:var(--slate-400);font-size:14px}
#q{border:0;outline:0;font:inherit;font-size:13px;flex:1;min-width:0;background:transparent;color:inherit}
.count{font-size:11.5px;color:var(--slate-500);font-variant-numeric:tabular-nums;white-space:nowrap}
.btn{font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:5px 11px;cursor:pointer;
  border:1px solid transparent;white-space:nowrap}
.btn-primary{background:var(--brand-600);color:#fff;border-color:var(--brand-600)}
.btn-primary:hover{background:var(--brand-700)}
.btn-ghost{background:#fff;color:var(--navy-700);border-color:var(--slate-300)}
.btn-ghost:hover{background:var(--slate-50);border-color:var(--slate-400)}

/* --- cards --- */
.card{background:#fff;border:1px solid var(--slate-200);border-radius:var(--radius);margin-bottom:14px;overflow:hidden}
.card-head{padding:10px 14px;border-bottom:1px solid var(--slate-200);background:var(--slate-50)}
.card-head h2{margin:0;font-size:14px;font-weight:700;color:var(--navy-800,#273746)}
.card-sub{margin:3px 0 0;font-size:11.5px;color:var(--slate-500);line-height:1.5}
.card-body{padding:0}
.card-body>p,.card-body>.notice,.card-body>.disc,.card-body>.tlines{margin-left:14px;margin-right:14px}
.card-body>p:first-child{margin-top:12px}
.card-body>*:last-child{margin-bottom:14px}
.note{font-size:11.5px;color:var(--slate-500);line-height:1.6;margin:12px 14px}
.note strong{color:var(--navy-700)}
.empty{font-size:12.5px;color:var(--slate-500);padding:16px 14px;margin:0;text-align:center}

/* --- tables --- */
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.tbl{border-collapse:collapse;width:100%;font-size:12.5px}
.tbl th{background:var(--slate-50);border-bottom:1px solid var(--slate-200);
  padding:7px 9px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;
  letter-spacing:.04em;color:var(--slate-500);white-space:nowrap;vertical-align:bottom}
.tbl th.sortable{cursor:pointer;user-select:none}
.tbl th.sortable:hover{color:var(--brand-700)}
.tbl th.sorted{color:var(--brand-700)}
.tbl th .caret::after{content:"";font-size:9px;margin-left:3px}
.tbl th.sorted[data-dir="asc"] .caret::after{content:"\\2191"}
.tbl th.sorted[data-dir="desc"] .caret::after{content:"\\2193"}
.tbl td{padding:6px 9px;border-bottom:1px solid var(--slate-100);vertical-align:top}
.tbl tbody tr.expandable{cursor:pointer}
.tbl tbody tr.expandable:hover{background:var(--slate-50)}
.tbl tbody tr.open{background:var(--brand-50)}
.al-left{text-align:left}.al-right{text-align:right}.al-center{text-align:center}
.num,.tbl td.num{font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.sub{display:block;font-size:9.5px;color:var(--slate-400);margin-top:1px}
.strong{font-weight:700}
.up{color:var(--up);font-weight:600;font-variant-numeric:tabular-nums}
.down{color:var(--down);font-weight:600;font-variant-numeric:tabular-nums}
.flat{color:var(--slate-400);font-variant-numeric:tabular-nums}
.muted{color:var(--slate-400)}
.toggle{color:var(--slate-400);width:26px}
.detail>td{background:var(--slate-50);padding:0;border-bottom:2px solid var(--slate-200)}
.detail-body{padding:10px 12px}
.dsec{margin-bottom:10px}
.dsec-h{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
  color:var(--slate-400);margin-bottom:3px}
.dlead{font-size:12px;color:var(--slate-600);margin:0 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.chip{background:#fff;border:1px solid var(--slate-200);border-radius:99px;
  padding:2px 8px;font-size:10px;color:var(--slate-500)}

/* --- trait lines (the expanded per-trait grid) --- */
.tlines{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:0 20px}
.tline{display:flex;align-items:baseline;gap:8px;padding:2px 5px;border-radius:4px;white-space:nowrap}
.tline.keyrow{background:rgba(208,236,231,.35)}
.tline.hl{background:var(--amber-bg)}
.tl-lead{width:66px;flex:none;text-align:right;font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums}
.tl-name{flex:1 1 auto;font-size:11px;color:var(--slate-600);overflow:hidden;text-overflow:ellipsis}
.keytag{font-size:8px;text-transform:uppercase;color:var(--brand-500);margin-left:4px;font-weight:700}
.tl-mid{flex:none;font-size:10px;color:var(--slate-400);font-variant-numeric:tabular-nums}
.tl-right{width:46px;flex:none;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;color:var(--slate-400)}
.tl-right.hlz{color:var(--amber);font-weight:700}

/* --- badges --- */
.badge{display:inline-block;border-radius:99px;padding:1px 7px;font-size:10px;font-weight:700;
  line-height:1.6;white-space:nowrap;border:1px solid}
.badge-good{background:var(--up-bg);color:#047857;border-color:#a7f3d0}
.badge-warn{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-bd)}
.badge-danger{background:var(--down-bg);color:#b91c1c;border-color:#fca5a5}
.badge-info{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
.badge-accent{background:var(--accent-50);color:var(--accent-600);border-color:#f5cba7}
.badge-muted,.badge-default{background:var(--slate-100);color:var(--slate-600);border-color:var(--slate-200)}
.flagpill{display:inline-block;background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-bd);
  border-radius:99px;padding:0 6px;font-size:10px;font-weight:700}
.bang{background:var(--amber-bg);color:var(--amber);border-radius:3px;padding:0 3px;
  font-size:8.5px;font-weight:700;margin-left:3px;vertical-align:middle}

/* --- disclosures --- */
.disc{border:1px solid var(--slate-200);border-radius:6px;background:var(--slate-50);margin:8px 0}
.disc>summary{cursor:pointer;padding:6px 11px;font-size:11.5px;font-weight:700;color:var(--slate-600);
  list-style-position:inside}
.disc>summary:hover{color:var(--brand-700)}
.disc-body{border-top:1px solid var(--slate-200);background:#fff;padding:8px 0 0;
  border-radius:0 0 6px 6px}
.disc-body>p{margin:0 11px 8px;font-size:11.5px;color:var(--slate-500)}
.disc-body>.tw{padding-bottom:4px}

/* --- female cards (mating report) --- */
.fcard{border:1px solid var(--slate-200);border-radius:var(--radius);background:#fff;margin-bottom:10px;overflow:hidden}
.fcard>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;
  gap:10px;padding:9px 13px;background:var(--slate-50);border-bottom:1px solid var(--slate-200)}
.fcard>summary::-webkit-details-marker{display:none}
.fcard[open]>summary{border-bottom:1px solid var(--slate-200)}
.fname{font-size:13.5px;font-weight:700;color:var(--navy-700)}
.freg{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--slate-500)}
.fspacer{flex:1 1 auto}
.fbest{font-size:12.5px;font-weight:700;color:var(--brand-700);white-space:nowrap}
.fbody{padding:11px 13px}

/* --- footer --- */
.doc-foot{margin-top:22px;border-top:2px solid var(--navy-200);padding-top:12px}
.foot-brand{font-size:12px;color:var(--navy-700);margin-bottom:6px}
.caveats{margin:0;padding-left:17px;font-size:11px;color:var(--slate-500);line-height:1.65}
.caveats li{margin-bottom:4px}

/* --- print --- */
@media print{
  @page{margin:12mm}
  body{background:#fff;font-size:10.5px}
  .wrap{max-width:none;padding:0}
  .no-print{display:none !important}
  .doc-head{background:#fff;color:var(--navy-900);border:1px solid var(--navy-200);
    border-bottom:3px solid var(--brand-500)}
  .doc-sub{color:var(--slate-600)}
  .when-label{color:var(--slate-500)}
  .logo{padding:0}
  /* A row must not be split across a page break, and a header must not be
     orphaned at the foot of one. */
  tr,.tline,.stat,.param{break-inside:avoid;page-break-inside:avoid}
  thead{display:table-header-group}
  .card,.fcard,.disc{break-inside:auto;page-break-inside:auto;border-color:var(--slate-300);box-shadow:none}
  .card-head,.fcard>summary{break-after:avoid;page-break-after:avoid}
  .tw{overflow:visible}
  table.tbl{font-size:9.5px}
  .tbl td,.tbl th{padding:3px 5px}
  /* Everything the reader could have opened on screen is on the paper. */
  .detail[hidden]{display:table-row !important}
  [data-view][hidden]{display:block !important}
  .disc,.fcard{background:#fff}
  .disc-body,.detail>td{background:#fff}
  a{text-decoration:none;color:inherit}
}
`;
