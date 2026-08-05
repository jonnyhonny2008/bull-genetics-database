"use client";

// Floating AI Genetics Assistant — a button fixed lower-right on every page that
// opens a slide-out chat panel. Talks to POST /api/agent. Shows a "thinking"
// state, then the answer + any charts the agent drew + the database records it
// used + suggested follow-ups. Charts open full screen.

import { useEffect, useRef, useState } from "react";
import { LineChart, CompareBars, type LineSeries } from "./TrendCharts";
import { cleanText, extractCharts, splitFollowups, type ChartSpec } from "@/lib/agent/answer-format";
import { reportMarkdown, recordsToRows, rowsToCsv, slugify, type ReportData } from "@/lib/agent/answer-export";

interface Msg {
  role: "user" | "assistant";
  content: string;
  records?: { tool: string; records: unknown }[];
  tools?: { name: string; summary: string }[];
  error?: boolean;
  streaming?: boolean;
  status?: string;
}

const CHART_PALETTE = ["#2f6551", "#d97706", "#2563eb", "#7c3aed", "#dc2626", "#0891b2"];

function AgentChart({ spec, height = 220 }: { spec: ChartSpec; height?: number }) {
  if (spec.type === "bars" && Array.isArray(spec.rows) && spec.rows.length > 0) {
    return <CompareBars rows={spec.rows} aLabel={spec.aLabel ?? "This"} bLabel={spec.bLabel ?? "Lineup"} />;
  }
  const series: LineSeries[] = (spec.series ?? [])
    .filter((s) => s && Array.isArray(s.points))
    .map((s, i) => ({ label: s.label ?? `Series ${i + 1}`, color: s.color ?? CHART_PALETTE[i % CHART_PALETTE.length], points: s.points, dashed: s.dashed }));
  if (series.length === 0) return null;
  return <LineChart series={series} height={height} yLabel={spec.yLabel} valueSuffix={spec.valueSuffix ?? ""} />;
}

const SUGGESTIONS = [
  "Which active proven bulls have the highest LPI?",
  "How many genomic vs proven sires are in the lineup?",
  "Which bulls are most rollback resistant?",
  "Chart BLONDIN DAKOTA's LPI over its proof rounds vs the lineup average.",
];

export function GeneticsAssistant() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [fullChart, setFullChart] = useState<ChartSpec | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && configured === null) {
      fetch("/api/agent").then((r) => (r.ok ? r.json() : { configured: false })).then((d) => setConfigured(!!d.configured)).catch(() => setConfigured(false));
    }
  }, [open, configured]);

  // Esc closes the full-screen chart first, then the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (fullChart) setFullChart(null);
      else if (open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullChart, open]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);

  // Merge fields into the last message (used to update the streaming bubble).
  const patchLast = (patch: Partial<Msg>) =>
    setMessages((m) => {
      const i = m.length - 1;
      if (i < 0 || m[i].role !== "assistant") return m;
      const next = m.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });

  async function ask(question: string) {
    const q = question.trim();
    if (!q || loading) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: q }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, history }) });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({} as { message?: string }));
        if (res.status === 503) setConfigured(false);
        setMessages((m) => [...m, { role: "assistant", content: data.message ?? "The assistant hit an error.", error: true }]);
        return;
      }
      // Open a streaming assistant bubble and fill it from the NDJSON stream.
      setMessages((m) => [...m, { role: "assistant", content: "", streaming: true }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt: { type: string; text?: string; code?: string; message?: string; result?: { answer: string; records?: Msg["records"]; toolCalls?: Msg["tools"] } };
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "delta") { acc += evt.text ?? ""; patchLast({ content: acc, status: undefined }); }
          else if (evt.type === "status") { patchLast({ status: evt.text }); }
          else if (evt.type === "done" && evt.result) { patchLast({ content: evt.result.answer, records: evt.result.records, tools: evt.result.toolCalls, streaming: false, status: undefined }); }
          else if (evt.type === "error") { if (evt.code === "not_configured") setConfigured(false); patchLast({ content: evt.message ?? "The assistant hit an error.", error: true, streaming: false, status: undefined }); }
        }
      }
      patchLast({ streaming: false });
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Network error — try again.", error: true }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Floating action button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open the AI genetics assistant"
        className="group fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-900/20 transition hover:scale-105 hover:bg-brand-700 active:scale-95"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
          <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z" />
        </svg>
      </button>

      {/* Slide-out panel */}
      <div className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-md transform flex-col bg-white shadow-2xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`} role="dialog" aria-hidden={!open}>
        <header className="flex items-center justify-between border-b border-slate-200 bg-brand-900 px-4 py-3 text-white">
          <div>
            <div className="text-sm font-bold">AI Genetics Assistant</div>
            <div className="text-[11px] text-brand-300">Grounded in your genetics database</div>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-brand-200 hover:bg-brand-800 hover:text-white" aria-label="Close">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3">
          {configured === false && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              The assistant isn&apos;t switched on yet. An administrator can add an Anthropic API key in <span className="font-semibold">Admin Settings → AI Genetics Assistant</span> to activate it.
            </div>
          )}
          {messages.length === 0 && configured !== false && (
            <div className="space-y-2">
              <p className="text-sm text-slate-500">Ask about sires, proofs, rankings, pedigree or trends — or ask it to make a change (add a note, record a proof, edit an animal). It does what your account is allowed to, and confirms before anything is saved. Try:</p>
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)} className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-brand-300 hover:bg-brand-50">{s}</button>
              ))}
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === "user") return <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white">{m.content}</div>;
            const streaming = !!m.streaming;
            // Mid-stream, hide any half-emitted ```chart block and don't parse
            // charts/follow-ups until the final "done" arrives.
            let charts: ChartSpec[] = [], body = "", followups: string[] = [];
            if (m.error) { body = m.content; }
            else if (streaming) { body = cleanText(m.content.split(/```chart/i)[0]); }
            else { const ex = extractCharts(m.content); const sp = splitFollowups(ex.text); charts = ex.charts; body = cleanText(sp.body); followups = sp.followups; }
            const clean = body;
            const prevUser = i > 0 && messages[i - 1]?.role === "user" ? messages[i - 1].content : undefined;
            return (
              <div key={i} className="max-w-[92%] space-y-2">
                <div className={`rounded-2xl rounded-bl-sm border px-3 py-2 text-sm ${m.error ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-800"}`}>
                  {streaming && m.status && !clean && (
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" />{m.status}</div>
                  )}
                  <div className="whitespace-pre-wrap leading-relaxed">{clean}{streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-brand-400 align-middle" />}</div>
                  {!m.error && !streaming && (
                    <div className="mt-2 flex items-center gap-3 border-t border-slate-100 pt-1.5 text-[11px] text-slate-400">
                      <button onClick={() => navigator.clipboard?.writeText(clean)} className="hover:text-brand-600">Copy</button>
                      {m.tools && m.tools.length > 0 && <RecordsToggle tools={m.tools} records={m.records ?? []} />}
                      <ExportMenu report={{ question: prevUser, answer: clean, tools: m.tools, records: m.records, charts }} />
                    </div>
                  )}
                </div>
                {charts.map((spec, ci) => (
                  <div key={ci} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-600">{spec.title ?? "Chart"}</span>
                      <button type="button" onClick={() => setFullChart(spec)} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100 hover:text-brand-600" title="View full screen">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m0 8v3a2 2 0 0 0 2 2h3m8-18h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3" /></svg>
                        Full screen
                      </button>
                    </div>
                    <AgentChart spec={spec} />
                  </div>
                ))}
                {followups.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {followups.map((f) => { const fc = cleanText(f); return <button key={f} onClick={() => ask(fc)} className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] text-slate-600 hover:border-brand-300 hover:bg-brand-50">{fc}</button>; })}
                  </div>
                )}
              </div>
            );
          })}

          {loading && !messages[messages.length - 1]?.streaming && <div className="flex items-center gap-2 text-sm text-slate-400"><span className="h-2 w-2 animate-bounce rounded-full bg-brand-400" /><span className="h-2 w-2 animate-bounce rounded-full bg-brand-400" style={{ animationDelay: "0.15s" }} /><span className="h-2 w-2 animate-bounce rounded-full bg-brand-400" style={{ animationDelay: "0.3s" }} /> investigating…</div>}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="border-t border-slate-200 bg-white p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
              rows={1}
              placeholder={configured === false ? "Assistant not configured" : "Ask about the genetics…"}
              disabled={configured === false || loading}
              className="max-h-32 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none disabled:bg-slate-50"
            />
            <button type="submit" disabled={configured === false || loading || !input.trim()} className="btn-primary shrink-0 disabled:opacity-40">Ask</button>
          </div>
        </form>
      </div>

      {/* Full-screen chart viewer — opens from any chart's "Full screen" button */}
      {fullChart && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-white" role="dialog" aria-modal="true">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div className="text-sm font-semibold text-slate-700">{fullChart.title ?? "Chart"}</div>
            <button type="button" onClick={() => setFullChart(null)} className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" aria-label="Close full screen">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              Close
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-auto p-4 sm:p-8">
            <div className="w-full max-w-6xl">
              <AgentChart spec={fullChart} height={480} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RecordsToggle({ tools, records }: { tools: { name: string; summary: string }[]; records: { tool: string; records: unknown }[] }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative">
      <button onClick={() => setShow((s) => !s)} className="hover:text-brand-600">{show ? "Hide" : "Show"} sources ({tools.length})</button>
      {show && (
        <div className="mt-2 max-h-64 w-full overflow-auto rounded border border-slate-200 bg-slate-50 p-2 text-left text-[11px] text-slate-600">
          {tools.map((t, i) => (
            <div key={i} className="mb-1.5">
              <div className="font-semibold text-slate-700">{t.name}</div>
              <div>{t.summary}</div>
            </div>
          ))}
          <details className="mt-1"><summary className="cursor-pointer text-slate-400">Raw records</summary><pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(records, null, 1).slice(0, 4000)}</pre></details>
        </div>
      )}
    </span>
  );
}

// Download some text as a file (client-side Blob, no server round-trip).
function downloadText(base: string, ext: string, mime: string, text: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${base}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

// Open a clean, printable report window (the browser's "Save as PDF" turns it
// into a PDF). Text + sources + a records table — dependency-free.
function printReport(report: ReportData) {
  const rows = recordsToRows(report.records ?? []);
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const table = rows.length
    ? `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c])}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`
    : "";
  const sources = report.tools?.length
    ? `<h2>Sources</h2><ul>${report.tools.map((t) => `<li><b>${esc(t.name)}</b>: ${esc(t.summary)}</li>`).join("")}</ul>`
    : "";
  const body = `<h1>Genetics report</h1>${report.question ? `<p class="q"><b>Question:</b> ${esc(report.question)}</p>` : ""}<div class="ans">${esc(report.answer)}</div>${sources}${rows.length ? `<h2>Records</h2>${table}` : ""}`;
  const w = window.open("", "_blank");
  if (!w) { window.alert("Allow pop-ups to print/save the report as a PDF."); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(report.question || "Genetics report")}</title><style>body{font:14px/1.6 system-ui,-apple-system,sans-serif;color:#1e293b;max-width:820px;margin:0 auto;padding:36px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 4px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}.q{color:#475569}.ans{white-space:pre-wrap;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:11px;margin-top:8px}th,td{border:1px solid #e2e8f0;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f8fafc}ul{margin:6px 0;padding-left:18px}</style></head><body>${body}</body></html>`);
  w.document.close(); w.focus();
  setTimeout(() => w.print(), 350);
}

// Export menu on each answer: Markdown, CSV (records), JSON (records), Print/PDF.
function ExportMenu({ report }: { report: ReportData }) {
  const [open, setOpen] = useState(false);
  const base = slugify(report.question ?? "genetics-report");
  const rows = recordsToRows(report.records ?? []);
  const item = "block w-full px-3 py-1.5 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <span className="relative">
      <button onClick={() => setOpen((o) => !o)} className="hover:text-brand-600">Export</button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-40 overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-[11px] text-slate-600 shadow-lg">
          <button className={item} onClick={() => { downloadText(base, "md", "text/markdown", reportMarkdown(report)); setOpen(false); }}>Markdown (.md)</button>
          <button className={item} disabled={!rows.length} onClick={() => { downloadText(base, "csv", "text/csv", rowsToCsv(rows)); setOpen(false); }}>CSV records</button>
          <button className={item} disabled={!report.records?.length} onClick={() => { downloadText(base, "json", "application/json", JSON.stringify(report.records, null, 2)); setOpen(false); }}>JSON records</button>
          <button className={item} onClick={() => { printReport(report); setOpen(false); }}>Print / PDF</button>
        </div>
      )}
    </span>
  );
}
