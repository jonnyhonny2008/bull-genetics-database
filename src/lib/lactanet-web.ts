import "server-only";

// ---------------------------------------------------------------------------
// Lactanet Genetics (lactanetgen.ca) animal fetcher.
//
// Replaces the Holstein.ca browser scraper. Every tab of an animal's record is
// a plain server-rendered PHP page behind a GET with three parameters, so this
// needs no browser at all — just fetch(). That is why it works on Vercel, where
// the Playwright/headful-Chrome path never could.
//
//   https://www.lactanetgen.ca/query/<tab>.php?breed=HO&country=CAN&sex=M&regnum=13486161
//
// Deliberately polite: one animal at a time, tabs fetched sequentially with a
// small delay, a single retry on transient failure, an identifying User-Agent,
// and a hard timeout. Nothing here evades or spoofs anything — if a request is
// refused we report it and stop.
// ---------------------------------------------------------------------------

const BASE = "https://www.lactanetgen.ca/query";

const UA =
  process.env.LACTANET_USER_AGENT ||
  "BullStudGeneticsPlatform/1.0 (internal herd-management tool)";

/** Delay between tab requests, ms. Raise via env if you want to be gentler. */
const GAP_MS = Number(process.env.LACTANET_GAP_MS ?? 400);
const TIMEOUT_MS = Number(process.env.LACTANET_TIMEOUT_MS ?? 20000);

// Lactanet renders DIFFERENT tabs for bulls vs cows:
//   • a bull's Type/Production/Functional/Health/Calving pages are his DAUGHTER
//     proofs (and type.php even PHP-crashes for a female with 0 daughters).
//   • a cow has her OWN classification.php (EX/VG score + linear scores) and
//     lactation.php (real 305-day milk records), plus detail-genomics.php.
// Fetching the wrong set for a cow was why females came back with no
// classification or lactations. Summary/pedigree/progeny are shared.
export const LACTANET_TAB_URLS = [
  "summary", "pedigree", "progeny",
  "type", "production", "functional", "health", "calving", // male daughter-proofs
  "classification", "lactation", "detail-genomics",         // female own-records
] as const;
export type LactanetTab = (typeof LACTANET_TAB_URLS)[number];

const MALE_TABS: readonly LactanetTab[] = ["summary", "pedigree", "progeny", "type", "production", "functional", "health", "calving"];
const FEMALE_TABS: readonly LactanetTab[] = ["summary", "pedigree", "progeny", "classification", "lactation", "detail-genomics"];

export const tabsForSex = (sex: "M" | "F"): readonly LactanetTab[] => (sex === "F" ? FEMALE_TABS : MALE_TABS);

/** Back-compat alias; defaults to the male tab set. */
export const LACTANET_TABS = MALE_TABS;

export interface LactanetRef {
  /** Full registration as stored, e.g. HOCANM13486161 */
  reg: string;
  breed: string; // HO, AY, BS, GU, CN, JE …
  country: string; // CAN, USA, 840, AUS …
  sex: "M" | "F";
  regnum: string; // digits only — what the query wants
}

/**
 * Split a registration into the parts lactanetgen.ca's query string needs.
 *
 * Canadian-style registrations pack it all in: HO | CAN | M | 13486161. Some
 * carry a numeric country ("HO840M3125170883" — the US 840 prefix), so the
 * country segment is matched as 3 alphanumerics rather than 3 letters.
 */
export function parseReg(regRaw: string): LactanetRef | null {
  const reg = regRaw.trim().toUpperCase().replace(/\s+/g, "");
  const m = /^([A-Z]{2})([A-Z0-9]{3})([MF])(\d+)$/.exec(reg);
  if (!m) return null;
  return { reg, breed: m[1], country: m[2], sex: m[3] as "M" | "F", regnum: m[4] };
}

export function tabUrl(ref: LactanetRef, tab: LactanetTab): string {
  const q = new URLSearchParams({
    breed: ref.breed,
    country: ref.country,
    sex: ref.sex,
    regnum: ref.regnum,
  });
  return `${BASE}/${tab}.php?${q}`;
}

export interface LactanetFetchResult {
  reg: string;
  ref: LactanetRef | null;
  /** Raw HTML per tab. A tab that failed is absent and listed in `errors`. */
  tabs: Partial<Record<LactanetTab, string>>;
  errors: Partial<Record<LactanetTab, string>>;
  error: string | null;
  fetchedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getOnce(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      cache: "no-store",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** One GET with a single retry — transient network blips shouldn't fail a row. */
async function get(url: string): Promise<string> {
  try {
    return await getOnce(url);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // Don't retry a definitive "not found" — only transient-looking failures.
    if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) throw e;
    await sleep(1200);
    return await getOnce(url);
  }
}

/**
 * Fetch every tab for one animal. Never throws: a failure lands in `error` (the
 * animal could not be read at all) or in `errors[tab]` (that section only).
 */
export async function fetchLactanetAnimal(
  regRaw: string,
  tabsOverride?: readonly LactanetTab[],
): Promise<LactanetFetchResult> {
  const ref = parseReg(regRaw);
  const out: LactanetFetchResult = {
    reg: ref?.reg ?? regRaw.trim().toUpperCase(),
    ref,
    tabs: {},
    errors: {},
    error: null,
    fetchedAt: new Date().toISOString(),
  };
  if (!ref) {
    out.error = `Could not read "${regRaw}" as a registration number (expected e.g. HOCANM13486161).`;
    return out;
  }
  // Sex decides which tabs exist — cows have classification/lactation, bulls
  // have daughter-proof pages. Getting this wrong returned empty female records.
  const tabs = tabsOverride ?? tabsForSex(ref.sex);

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    try {
      const html = await get(tabUrl(ref, tab));
      // A data page that can't be resolved 302-redirects to the search form
      // (query-individual.php), which `redirect:"follow"` turns into a 200 of
      // the FORM. Detect that so we report "not found" instead of importing a
      // phantom animal (name = reg, 0 traits) — the symptom for a non-genotyped
      // heifer Lactanet doesn't individually publish.
      if (tab === "summary" && isSearchForm(html)) {
        out.error = `Lactanet has no individual record for ${ref.reg}. It may be a young, non-genotyped animal that isn't individually published yet — compute its Parent Average from its sire and dam instead.`;
        return out;
      }
      out.tabs[tab] = html;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).split("\n")[0];
      out.errors[tab] = msg;
      // Summary is the existence check — if it fails, the rest is pointless.
      if (tab === "summary") {
        out.error = `Lactanet has no readable record for ${ref.reg} (${msg}).`;
        return out;
      }
    }
    if (i < tabs.length - 1) await sleep(GAP_MS);
  }
  return out;
}

/** True when the HTML is the query-individual search form (the redirect target
 *  Lactanet serves for an animal it can't resolve), not a data page. The search
 *  form uniquely carries the semen-code + registration query inputs. */
function isSearchForm(html: string): boolean {
  return /name=["']q_sirecode["']/i.test(html) && /name=["']q_reg["']/i.test(html);
}

/** Fetch many animals sequentially, reporting progress. Politeness by design. */
export async function fetchLactanetAnimals(
  regs: string[],
  onProgress?: (done: number, total: number, last: LactanetFetchResult) => void,
): Promise<LactanetFetchResult[]> {
  const list = [...new Set(regs.map((r) => r.trim().toUpperCase()).filter(Boolean))];
  const results: LactanetFetchResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = await fetchLactanetAnimal(list[i]);
    results.push(r);
    onProgress?.(i + 1, list.length, r);
    if (i < list.length - 1) await sleep(GAP_MS);
  }
  return results;
}
