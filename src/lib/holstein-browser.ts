import "server-only";

// ---------------------------------------------------------------------------
// Server-side Holstein.ca scraper powered by a REAL local browser (Playwright
// driving the installed Chrome). holstein.ca sits behind an Incapsula WAF that
// 403s plain HTTP, headless Chrome, AND direct deep-links / same-origin fetch.
// What DOES pass, reliably, is a headful real Chrome performing genuine in-site
// navigation: open the Main animal page, then CLICK each tab (real navigation
// with a Referer). That's exactly what this module does.
//
// Consequence: this only works where a real Chrome is installed and a display is
// available — the app running locally / on a desktop-class host, NOT serverless.
// The browser is a lazily-created singleton reused across lookups (one page,
// scrapes serialized). Call closeHolsteinBrowser() to release it.
// ---------------------------------------------------------------------------

import type { Browser, Page } from "playwright-core";
import type { HolsteinRawExtract, HolsteinTable } from "./holstein-parse";

let browserP: Promise<Browser> | null = null;
let pageP: Promise<Page> | null = null;
let chain: Promise<unknown> = Promise.resolve(); // serialize scrapes on the single page

const HEADLESS = process.env.HOLSTEIN_HEADLESS === "1"; // headless is WAF-blocked; default headful
const BASE = "https://www.holstein.ca";

// Where the browser lives:
//   • HOLSTEIN_CDP_URL set  → connect to a REMOTE browser over CDP (a hosted
//     stealth-browser service like Browserbase/Browserless whose real browsers +
//     residential IPs defeat holstein.ca's Incapsula WAF). This is the mode used
//     on Vercel / any serverless host, which cannot run a local Chrome.
//   • otherwise             → launch the LOCAL installed Chrome (headful) — the
//     dev / desktop-host mode.
// The scraping engine (navigate + click tabs + evaluate) is identical either way.
const CDP_URL = (process.env.HOLSTEIN_CDP_URL || "").trim();
export const HOLSTEIN_REMOTE = !!CDP_URL;

// A single place to explain the failure when no browser is reachable, so the API
// routes can turn it into a helpful message (e.g. "set HOLSTEIN_CDP_URL").
export class HolsteinBrowserUnavailable extends Error {}

async function getBrowser(): Promise<Browser> {
  if (!browserP) {
    const { chromium } = await import("playwright-core");
    browserP = (CDP_URL
      ? chromium.connectOverCDP(CDP_URL)
      : chromium.launch({
          channel: process.env.HOLSTEIN_CHROME_CHANNEL || "chrome",
          headless: HEADLESS,
          args: ["--start-minimized", "--disable-blink-features=AutomationControlled"],
        })
    ).catch((e: unknown) => {
      browserP = null; // allow a later retry
      const how = CDP_URL
        ? `Could not connect to the remote browser at HOLSTEIN_CDP_URL. Check the endpoint/token of your browser service (e.g. Browserbase/Browserless).`
        : `Could not launch a local Chrome. On a server with no desktop Chrome (e.g. Vercel), set HOLSTEIN_CDP_URL to a hosted stealth-browser CDP endpoint.`;
      throw new HolsteinBrowserUnavailable(`${how} (${(e as Error)?.message ?? e})`);
    });
  }
  return browserP;
}

async function getPage(): Promise<Page> {
  if (!pageP) {
    pageP = (async () => {
      const browser = await getBrowser();
      // Reuse the remote service's default context/page when connecting over CDP;
      // create a fresh one for a locally-launched browser.
      const ctx = CDP_URL ? (browser.contexts()[0] ?? await browser.newContext()) : await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = ctx.pages()[0] ?? await ctx.newPage();
      return page;
    })().catch((e) => { pageP = null; throw e; });
  }
  return pageP;
}

// Passed to page.evaluate as STRINGS on purpose — an inlined function would get
// bundler helpers injected (esbuild/SWC `__name`) that don't exist in the page
// context and throw "__name is not defined". A raw string is immune to that.
const EXTRACT_STR = String.raw`(function(){var clean=function(s){return (s||"").replace(/ /g," ").replace(/[ \t]+/g," ").replace(/\s+\n/g,"\n").trim();};var tables=Array.prototype.map.call(document.querySelectorAll("table"),function(t){return {head:clean(t.rows[0]&&t.rows[0].cells.length===1?t.rows[0].innerText:""),rows:Array.prototype.map.call(t.rows,function(r){return Array.prototype.map.call(r.cells,function(c){return clean(c.innerText);});})};});return {text:clean(document.body.innerText),tables:tables};})()`;
const ANIMALID_STR = String.raw`((document.body.innerHTML.match(/animalId=(\d+)/i)||[])[1]||null)`;

// Family-tree ancestors with TRUE generation, computed from the rowspan grid.
// holstein.ca's pedigree is a rowspan table, so a cell's index within its row is
// NOT its generation; we replay rowspan/colspan occupancy to get the real column.
// col 0 = parent (gen 1), col 1 = grandparent (gen 2), col 2 = great-grandparent.
const FT_GRID_STR = String.raw`(function(){var out=[];var tables=document.querySelectorAll('table');for(var ti=0;ti<tables.length;ti++){var t=tables[ti];var head=(t.rows[0]&&t.rows[0].cells.length===1)?(t.rows[0].innerText||'').trim():'';var side=/^Sire$/i.test(head)?'sire':(/^Dam$/i.test(head)?'dam':null);if(!side)continue;var occ={};for(var r=0;r<t.rows.length;r++){var c=0;for(var k=0;k<t.rows[r].cells.length;k++){var td=t.rows[r].cells[k];while(occ[r+'_'+c])c++;var rs=td.rowSpan||1,cs=td.colSpan||1;var txt=(td.innerText||'').replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').trim();if(txt&&!/^(Sire|Dam)$/i.test(txt))out.push({side:side,generation:c+1,text:txt});for(var i=0;i<rs;i++)for(var j=0;j<cs;j++)occ[(r+i)+'_'+(c+j)]=true;c+=cs;}}}return out;})()`;
// Family-tree "ready" predicate: a Sire/Dam table exists AND contains ancestor
// registrations (the grid renders async, so we must wait for it).
const FT_READY_STR = String.raw`(function(){return Array.prototype.some.call(document.querySelectorAll('table'),function(t){var h=(t.rows[0]&&t.rows[0].cells.length===1?t.rows[0].innerText:'').trim();return /^(Sire|Dam)$/i.test(h)&&/HO[A-Z]{3}/.test(t.innerText);});})()`;

function extractCurrent(page: Page): Promise<{ text: string; tables: HolsteinTable[] }> {
  return page.evaluate(EXTRACT_STR) as Promise<{ text: string; tables: HolsteinTable[] }>;
}

// --- Family-tree readiness --------------------------------------------------
// The pedigree grid renders async, so the flat 650ms sleep in the tab loop is a
// guess. Poll FT_READY_STR (declared above, previously unused) instead.
//
// Deliberately a manual poll on page.evaluate rather than page.waitForFunction:
//   • evaluate goes through CDP Runtime.evaluate — the exact mechanism the rest
//     of this module already uses successfully against holstein.ca.
//   • waitForFunction runs globalThis.eval in the page's MAIN world
//     (playwright-core/lib/coreBundle.js:23861), so it is subject to the SITE's
//     CSP; a script-src without 'unsafe-eval' would make it throw.
//   • it also sidesteps two waitForFunction defaults that bite here:
//     polling defaults to 'raf' (coreBundle.js:23890 — and this Chrome is
//     launched --start-minimized, so requestAnimationFrame is suspended), and
//     timeout resolves to DEFAULT_PLAYWRIGHT_TIMEOUT = 30s
//     (coreBundle.js:57160-57170), despite types.d.ts:25842 claiming 0.
//
// Never throws: the pedigree is optional, so a timeout returns false and the
// caller carries on to the existing table-parse fallback
// (holstein-parse.ts:446-455).
async function waitForFamilyTree(page: Page, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await page.evaluate(FT_READY_STR)) as boolean) return true;
    } catch { /* execution context torn down mid-navigation — retry */ }
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

const TABS: [label: string, key: string][] = [
  ["Genetics", "genetics"],
  ["Conformation", "conformation"],
  ["Family Tree", "familyTree"],
  ["Owner History", "ownerHistory"],
  ["Progeny", "progeny"],
  ["Show & Awards", "showAwards"],
];

// --- Passive bot-protection interstitial handling ---------------------------
// STRICTLY PASSIVE. This waits for a Cloudflare/Incapsula interstitial to clear
// BY ITSELF and reports a clear failure if it does not. It deliberately does NOT
// solve CAPTCHAs, click challenge widgets, spoof fingerprints, or otherwise evade
// the bot check: if the site does not let us through on its own, the correct
// outcome is to stop and say so. Do not "improve" this by interacting with the
// challenge.
export class HolsteinChallengeBlocked extends Error {}

const CHALLENGE_TITLE_RE = /just a moment|checking your browser|attention required|verify(ing)? you are human|request unsuccessful/i;
const CHALLENGE_BODY_RE = /checking your browser before accessing|verifying you are human|review the security of your connection|enable javascript and cookies to continue|incapsula incident id|_incapsula_resource/i;

// One cheap probe: title + the first 4k of body text. Kept as a STRING for the
// same bundler-helper reason as EXTRACT_STR (see the comment above it).
const CHALLENGE_PROBE_STR = String.raw`(function(){return {t:document.title||"",b:((document.body&&document.body.innerText)||"").slice(0,4000)};})()`;

type ChallengeProbe = { kind: "clear" } | { kind: "challenge"; why: string } | { kind: "unknown" };

async function probeChallenge(page: Page): Promise<ChallengeProbe> {
  try {
    const { t, b } = (await page.evaluate(CHALLENGE_PROBE_STR)) as { t: string; b: string };
    const hit = CHALLENGE_TITLE_RE.exec(t) ?? CHALLENGE_BODY_RE.exec(b);
    return hit ? { kind: "challenge", why: `"${hit[0]}"` } : { kind: "clear" };
  } catch {
    return { kind: "unknown" }; // execution context torn down mid-reload — re-probe, don't conclude
  }
}

// Returns "none" (never looked like an interstitial) or "cleared" (one resolved on
// its own). Throws HolsteinChallengeBlocked if it is still up after budgetMs.
async function waitForChallengeToClear(page: Page, budgetMs = 25000): Promise<"none" | "cleared"> {
  const deadline = Date.now() + budgetMs;
  let seen: string | null = null;
  let unknowns = 0;
  for (;;) {
    const p = await probeChallenge(page);
    if (p.kind === "clear") return seen ? "cleared" : "none";
    if (p.kind === "challenge") { seen = p.why; unknowns = 0; }
    else if (!seen && ++unknowns >= 3) return "none"; // page never looked like a challenge
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(1000); // passive: wait, touch nothing
  }
  throw new HolsteinChallengeBlocked(
    `holstein.ca served a bot-protection interstitial (${seen ?? "unrecognized"}) that did not clear on its own within ${Math.round(budgetMs / 1000)}s. ` +
    `No bypass is attempted — try again later, or from a browser/IP the site accepts.`,
  );
}

export type ScrapeResult = HolsteinRawExtract;

// Scrape one animal across every tab. Serialized on the shared page.
export async function scrapeHolsteinAnimal(reg: string): Promise<ScrapeResult> {
  const run = chain.then<ScrapeResult>(async () => {
    const page = await getPage();
    const R = reg.trim().toUpperCase();
    const out: ScrapeResult = { reg: R, animalId: null, name: null, mainText: "", genText: null, genTables: null, extraTabs: {}, error: null, scrapedAt: new Date().toISOString() };
    try {
      const resp = await page.goto(`${BASE}/en/AIS/AIS?animalRegNo=${encodeURIComponent(R)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(900);
      // Interstitials are served WITH a 4xx/5xx status, so this must run BEFORE
      // the status check — otherwise a challenge that clears by itself a second
      // later is reported as a permanent "HTTP 403".
      const challenge = await waitForChallengeToClear(page);
      if (challenge === "cleared") {
        // The probe can read "clear" during the redirect OFF the challenge page,
        // when title and body are momentarily empty and match neither regex.
        // Settle on the real document before extracting. Bounded and swallowed —
        // the animalId guard below is the real correctness check.
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      }
      // When a challenge cleared, `resp` describes the CHALLENGE document, not the
      // animal page, so its status is meaningless. The `animalId not found` guard
      // below still catches a genuinely bad page.
      if (challenge === "none" && resp && resp.status() >= 400) throw new Error(`main page HTTP ${resp.status()}`);
      const main = await extractCurrent(page);
      out.mainText = main.text;
      const mainTables = main.tables;
      out.animalId = (await page.evaluate(ANIMALID_STR)) as string | null;
      const lines = main.text.split("\n").map((s) => s.trim()).filter(Boolean);
      const ri = lines.findIndex((l) => l.includes(R));
      out.name = ri > 0 ? lines[ri - 1] : null;
      if (!out.animalId) { out.error = "animalId not found (animal not public?)"; return out; }

      const extra: Record<string, { text?: string | null; tables?: HolsteinTable[] | null; error?: string }> = {};
      for (const [label, key] of TABS) {
        try {
          await page.getByRole("link", { name: label, exact: true }).first().click({ timeout: 9000 });
          await page.waitForLoadState("domcontentloaded");
          // A tab click is a real navigation, so it can trip the WAF too.
          await waitForChallengeToClear(page);
          // Wait for the pedigree grid BEFORE snapshotting. extractCurrent()'s
          // tables are the fallback source parseHolsteinProfile uses when
          // familyTreeNodes is empty (holstein-parse.ts:446-455), so BOTH must be
          // taken after the grid renders or the fallback is empty too.
          if (key === "familyTree") await waitForFamilyTree(page);
          await page.waitForTimeout(650);
          const d = await extractCurrent(page);
          if (key === "genetics") { out.genText = d.text; out.genTables = d.tables; }
          if (key === "familyTree") {
            try { out.familyTreeNodes = (await page.evaluate(FT_GRID_STR)) as { side: string; generation: number; text: string }[]; } catch { /* fall back to table parse */ }
          }
          extra[key] = { text: d.text, tables: d.tables };
        } catch (e) {
          const msg = String((e as Error)?.message ?? e).split("\n")[0];
          extra[key] = { error: msg };
          // A live challenge stops the tab loop — don't click five more tabs into a
          // WAF that has already decided to block us. BREAK, do not re-throw:
          // re-throwing skips `out.extraTabs = extra` (line 143) while mainText
          // stays populated, so holstein-ingest.ts:54 still imports, and
          // storeHolsteinProfile's unconditional
          // `animal.update({ holsteinProfileJson })` (holstein-import.ts:191)
          // would overwrite a previously-good stored profile with an empty one.
          if (e instanceof HolsteinChallengeBlocked) { out.error = msg; break; }
        }
      }
      extra.main = { text: out.mainText, tables: mainTables }; // main page tables carry the lactation/production records
      out.extraTabs = extra;
    } catch (e) {
      out.error = String((e as Error)?.message ?? e).split("\n")[0];
    }
    return out;
  });
  chain = run.catch(() => undefined);
  return run;
}

// Scrape many animals sequentially (polite; reuses the one browser).
export async function scrapeHolsteinAnimals(
  regs: string[],
  onProgress?: (done: number, total: number, last: ScrapeResult) => void,
): Promise<ScrapeResult[]> {
  const list = [...new Set(regs.map((r) => r.trim().toUpperCase()).filter(Boolean))];
  const results: ScrapeResult[] = [];
  for (let i = 0; i < list.length; i++) {
    let res: ScrapeResult;
    try { res = await scrapeHolsteinAnimal(list[i]); }
    catch (e) { res = { reg: list[i], mainText: "", error: String((e as Error)?.message ?? e) }; }
    results.push(res);
    onProgress?.(i + 1, list.length, res);
  }
  return results;
}

export async function closeHolsteinBrowser(): Promise<void> {
  const b = browserP ? await browserP.catch(() => null) : null;
  browserP = null; pageP = null;
  if (b) await b.close().catch(() => {});
}
