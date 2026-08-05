import "server-only";

// The Mating Program report as a single self-contained HTML file. Takes the
// SAME MatingReport the page and the workbook use, so the numbers cannot drift;
// every value goes through esc()/badge()/the formatters in ./report-html, so a
// cow named `<script>…</script>` renders as visible text in the recipient's
// mail client. Mirrors src/lib/mating-program-xlsx.ts in what it shows and
// src/components/MatingProgramResults.tsx in how it is laid out.

import type { MatingReport, MatingFemale, MatingMatch } from "./mating-program";
import { MATING_DISPLAY_TRAITS } from "./mating-score";
import {
  esc, badge, cap, table, section, disclosure, htmlDocument, noticeHtml, num2,
  type Row, type Column, type Cell, type Stat,
} from "./report-html";

const EXCL_CAP = 200; // exclusions listed per female before the note bites

const femaleLabel = (f: MatingFemale): string => (f.name ? `${f.name} (${f.reg})` : f.reg);
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** "↑DF ↑MSPD" — the flagged faults this bull improves, for the name cell. */
function correctsHtml(m: MatingMatch): string {
  if (!m.corrects.length) return "";
  return (
    ` ` +
    m.corrects
      .map((c) => `<span class="chip" style="background:#e7f6ec;color:#1b7a3d">↑${esc(c)}</span>`)
      .join(" ")
  );
}

/** The recommendation rows for one female — the cleared bulls, best first. */
function matchRows(f: MatingFemale, scored: boolean): Row[] {
  return f.matches.map((m: MatingMatch, i): Row => {
    const cells: Cell[] = [
      { html: `<span class="rank">${i + 1}</span>`, sort: i },
      { html: esc(m.name) + correctsHtml(m), sort: m.name },
      { html: m.naab ? `<span class="mono">${esc(m.naab)}</span>` : "—", sort: m.naab ?? "" },
      { html: m.reg ? `<span class="mono">${esc(m.reg)}</span>` : "—", sort: m.reg ?? "" },
    ];
    if (scored) {
      cells.push({ html: m.matchScore == null ? "—" : `<strong>${num2(m.matchScore)}</strong>`, sort: m.matchScore, className: "al-right" });
    }
    // One projected-calf column per displayed trait.
    for (const t of MATING_DISPLAY_TRAITS) {
      const row = m.traits.find((x) => x.code === t.code) ?? m.pa.find((x) => x.code === t.code);
      const v = row && "pa" in row ? (row as { pa: number | null }).pa : (row as { value: number } | undefined)?.value ?? null;
      cells.push({ html: v == null ? "—" : num2(v), sort: v, className: "al-right" });
    }
    cells.push({ html: `<span class="chip">${pct(m.confidence)}</span>`, sort: m.confidence, className: "al-right" });
    return { cells };
  });
}

function femaleColumns(scored: boolean): Column[] {
  const cols: Column[] = [
    { label: "#", sort: "num", width: "3ch" },
    { label: "Bull", sort: "text" },
    { label: "NAAB", sort: "text" },
    { label: "Reg", sort: "text" },
  ];
  if (scored) cols.push({ label: "Match", sort: "num", align: "right", title: "100 = the average of the bulls in this run; higher is a better fit for her" });
  for (const t of MATING_DISPLAY_TRAITS) cols.push({ label: t.label, sort: "num", align: "right" });
  cols.push({ label: "Checked", sort: "num", align: "right", title: "Pedigree completeness of the blinder of the two animals" });
  return cols;
}

/** Her weaknesses and the goal for each — the reason the recommendations look
 *  the way they do. Nothing when she has no detected fault. */
function weaknessHtml(f: MatingFemale, strict: boolean): string {
  const acted = f.weaknesses.filter((w) => w.acted);
  const noted = f.weaknesses.filter((w) => !w.acted);
  if (!acted.length && !noted.length && !f.setbackTotal) return "";
  const chip = (label: string, cowValue: number, goal: string, deep: boolean) =>
    `<span class="chip" title="${esc(goal)}${deep ? " (checked on the recommended bulls only)" : ""}"><strong>${esc(label)}</strong> ${num2(cowValue)}${deep ? " ◇" : ""}</span>`;
  const parts: string[] = [];
  if (acted.length) {
    parts.push(
      `<p>Mating to correct her weaknesses. Every recommended bull ${strict ? "is <strong>positive</strong> for" : "at least does not set back"} ${acted.length === 1 ? "this trait" : "these traits"}; bulls that would are listed under <em>Set aside</em>. Bulls that fix the most rank first.</p>`,
      `<p>${acted.map((w) => chip(w.label, w.cowValue, w.goal, w.deep)).join(" ")}</p>`,
    );
  } else {
    parts.push(`<p>No major weakness detected on the traits we track — ranked on merit, with the never-worsen floor still on.</p>`);
  }
  if (noted.length) parts.push(`<p class="muted">Also below average, not acted on: ${noted.map((w) => chip(w.label, w.cowValue, w.goal, w.deep)).join(" ")}</p>`);
  if (f.unassessedWeak.length) parts.push(`<p class="muted">Could not read ${esc(f.unassessedWeak.map((u) => u.label).join(", "))} for her — no value on file, so not screened.</p>`);
  return noticeHtml(parts.join(""), acted.length ? "default" : "muted");
}

/** The set-aside panel — cleared the screen but would worsen a weakness. */
function setbackBody(f: MatingFemale, strict: boolean): string {
  if (!f.setbackTotal) return `<p class="empty">No cleared bull would set back any of her flagged weaknesses.</p>`;
  const rows: Row[] = f.setback.map((s): Row => ({
    cells: [
      { html: esc(s.name) + (s.reg ? ` <span class="mono muted">${esc(s.reg)}</span>` : ""), sort: s.name },
      { html: s.naab ? `<span class="mono">${esc(s.naab)}</span>` : "—" },
      { html: esc(s.reasons.join("; ")) },
    ],
  }));
  const t = table({
    columns: [
      { label: "Bull", sort: "text" },
      { label: "NAAB", sort: "text" },
      { label: `Why it was set aside${strict ? " (strict — must be positive)" : ""}`, sort: "none" },
    ],
    rows,
  });
  const note = f.setbackTotal > f.setback.length ? `<p class="cap-note">Showing ${f.setback.length} of ${f.setbackTotal}. The Excel export lists every one.</p>` : "";
  return `<p class="muted">These bulls cleared the relatedness screen but were kept out of the recommendations because they would ${strict ? "not be positive for" : "set back"} one of her weaknesses. They are never recommended.</p>${t}${note}`;
}

/** The excluded panel — the audit trail. Named ancestor, both generations. */
function excludedBody(f: MatingFemale): string {
  const { items, note } = cap(f.excluded, EXCL_CAP, "exclusions");
  if (!items.length) return `<p class="empty">No bull in the pool shares a registered ancestor with her inside the screened generations.</p>`;
  const rows: Row[] = items.map((e): Row => {
    const s = e.shared[0];
    return {
      cells: [
        { html: esc(e.name), sort: e.name },
        { html: s ? esc(s.name ?? s.reg) : "—", sort: s?.name ?? "" },
        { html: s ? `<span class="mono">${esc(s.reg)}</span>` : "—" },
        { html: s ? esc(s.label) : "—" },
      ],
    };
  });
  const t = table({
    columns: [
      { label: "Bull", sort: "text" },
      { label: "Shared ancestor", sort: "text" },
      { label: "Reg", sort: "none" },
      { label: "Relationship", sort: "none" },
    ],
    rows,
  });
  return note ? `${t}<p class="cap-note">${note}</p>` : t;
}

/** The withheld panel — could not be certified, never recommended. */
function unknownBody(f: MatingFemale): string {
  if (!f.unknown.length) return `<p class="empty">Every screened bull could be certified for her.</p>`;
  const rows: Row[] = f.unknown.map((m): Row => ({
    cells: [
      { html: esc(m.name), sort: m.name },
      { html: m.naab ? `<span class="mono">${esc(m.naab)}</span>` : "—" },
      { html: `<span class="chip">${pct(m.confidence)}</span>`, sort: m.confidence, className: "al-right" },
      { html: esc(m.reason || "pedigree too thin to screen"), sort: m.reason },
    ],
  }));
  return table({
    columns: [
      { label: "Bull", sort: "text" },
      { label: "NAAB", sort: "text" },
      { label: "Checked", sort: "num", align: "right" },
      { label: "Why it could not be checked", sort: "none" },
    ],
    rows,
  });
}

/** One female's whole card: header, weaknesses, recommendations, disclosures. */
function femaleSection(f: MatingFemale, scored: boolean, strict: boolean): string {
  const src =
    f.source === "lactanet"
      ? badge("Lactanet — not saved", "info")
      : f.source === "internal"
        ? badge("In database", "muted")
        : "";
  const acted = f.weaknesses.filter((w) => w.acted).length;
  const sub = [
    src,
    f.basis ? badge(esc(f.basis), "muted") : "",
    `<span class="chip">Pedigree ${pct(f.cowComplete)}</span>`,
    acted ? badge(`${acted} weakness${acted === 1 ? "" : "es"}`, "warn") : "",
    f.reliability != null ? `<span class="muted">Rel ${pct(f.reliability)}</span>` : "",
  ].filter(Boolean).join(" ");

  if (f.error) {
    return section(femaleLabel(f), `<div class="notice notice-danger">${esc(f.error)}</div>`, undefined);
  }

  const notes = f.notes.length
    ? `<ul class="notes">${f.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : "";

  const recs = f.matches.length
    ? table({ columns: femaleColumns(scored), rows: matchRows(f, scored) })
    : `<div class="notice notice-warn">No bull in the pool could be cleared for this female — see the Set aside, Excluded and unverifiable lists below.</div>`;

  const body = [
    `<div class="fem-sub">${sub}</div>`,
    weaknessHtml(f, strict),
    notes,
    recs,
    disclosure(`Set aside — ${f.setbackTotal} bull${f.setbackTotal === 1 ? "" : "s"} would set back a weakness`, setbackBody(f, strict)),
    disclosure(`Excluded — ${f.excludedTotal} bull${f.excludedTotal === 1 ? "" : "s"}`, excludedBody(f)),
    disclosure(`Not enough pedigree to check — ${f.unknown.length} bull${f.unknown.length === 1 ? "" : "s"}`, unknownBody(f)),
  ].join("\n");

  return section(femaleLabel(f), body, `${f.matches.length} recommended · ${f.setbackTotal} set aside · ${f.excludedTotal} excluded · ${f.unknown.length} unverifiable`);
}

export function matingProgramHtml(report: MatingReport): string {
  const multi = report.params.selected.length > 1;
  const scored = report.scored;
  const strict = report.params.strictImprovers;
  const resolved = report.females.filter((f) => !f.error).length;
  const failed = report.females.length - resolved;
  const withheld = report.females.reduce((n, f) => n + f.unknown.length, 0);
  const setAside = report.females.reduce((n, f) => n + f.setbackTotal, 0);

  const stats: Stat[] = [
    { label: "Females resolved", value: resolved, hint: failed ? `${failed} could not be read` : undefined, tone: failed ? "warn" : "good" },
    { label: "Bulls considered", value: report.bullsConsidered },
    { label: "Set aside for a weakness", value: setAside, tone: setAside ? "warn" : "default" },
    { label: "Median exclusion", value: report.females.length ? `${Math.round(report.medianExclusionPct)}%` : "—", hint: "of the pool, per female" },
    { label: "Withheld unverifiable", value: withheld, tone: withheld ? "warn" : "default" },
  ];

  const params: { label: string; value: string }[] = [
    { label: "Ranked on", value: multi ? report.params.selected.map((s) => (s.weight === 1 ? s.label : `${s.label} ×${s.weight}`)).join(" + ") : (report.params.index) },
    { label: "Correction balance", value: `${Math.round(report.params.blend * 100)}% index / ${Math.round((1 - report.params.blend) * 100)}% fix faults` },
    { label: "Weakness floor", value: strict ? "strict — must be positive" : "never worsen" },
    { label: "Faults acted on", value: String(report.params.weakN) },
    { label: "Bull pool", value: report.params.pool },
    { label: "Bulls per female", value: String(report.params.topN) },
    { label: "Screening depth", value: report.params.maxGen === 0 ? "off (audit mode)" : `${report.params.maxGen} generations` },
    { label: "Completeness floor", value: String(report.effectiveFloor) },
    { label: "Include inactive", value: report.params.includeInactive ? "yes" : "no" },
    { label: "NAAB code only", value: report.params.naabOnly ? "yes" : "no" },
  ];

  const notices = report.warnings.map((w) => `<div class="notice notice-warn">${esc(w)}</div>`);
  if (report.params.maxGen === 0) {
    notices.unshift(`<div class="notice notice-danger"><strong>Audit mode — screening is off.</strong> Bulls are ranked without any relatedness exclusion. These rows are not mating recommendations.</div>`);
  }

  const sections = report.females.length
    ? report.females.map((f) => femaleSection(f, scored, strict))
    : [`<div class="notice notice-warn">No females were resolved for this run.</div>`];

  return htmlDocument({
    docTitle: `Mating Program — ${report.females.length} female${report.females.length === 1 ? "" : "s"}`,
    reportTitle: "Mating Program",
    subtitle: "Each female is matched to bulls that raise the calf's index while correcting her own weaknesses — no recommended bull sets back a flagged weakness — with any bull sharing a registered ancestor inside the screened generations excluded.",
    params,
    generatedAt: new Date(report.generatedAt ?? Date.now()),
    stats,
    notices,
    sections,
    footnotes: [
      "A bull is set aside — never recommended — when he would make one of her flagged weaknesses worse. Daughter Fertility and the production traits are checked across the whole pool; Milking Speed and Bone Quality are checked on the recommended bulls only, as they have no fast column.",
      "The relatedness screen stops at three generations. Holstein populations share great-great-grandsires routinely, so a bull cleared here can still carry ancestral inbreeding — a green “Checked” figure is not a claim of zero inbreeding.",
      "Bulls whose pedigree is too thin to screen are WITHHELD from the recommendations and listed separately, because a bull we could not screen is not the same as a bull we cleared.",
      "The projected calf figures are parent averages (bull + dam ÷ 2), not a prediction of the calf's own future proof.",
    ],
  });
}
