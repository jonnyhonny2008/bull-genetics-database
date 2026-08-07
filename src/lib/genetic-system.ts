// ---------------------------------------------------------------------------
// CANADIAN vs AMERICAN — the two halves of the app.
//
// The app is effectively two programs sharing one animal roster: the Canadian
// side built on Lactanet/CDN evaluations (LPI, Pro$, EBVs in kg) and the American
// side built on CDCB evaluations (TPI, PTAT, NM$, PTAs in pounds). A toggle in
// the nav switches between them.
//
// THE SYSTEM IS CARRIED IN THE URL, NOT A COOKIE. This is a correctness decision,
// not a style one:
//
//   * SavedSearch stores a literal {path, query} and replays it as a link. Its own
//     schema example is `spec=MSPD,DF` — and MSPD means completely different
//     things in the two systems (US: lb of milk per minute from parlour sensors;
//     CA: a classifier score centred on 100). With a cookie toggle, opening a
//     saved Canadian search while the American side was active would silently
//     re-run it against a different measurement and return a wrong lineup.
//   * Every report export is a plain GET route that people email around. A cookie
//     would make the same link render different data for different recipients.
//   * 35 pages are force-dynamic with prefetch off, so a URL segment costs nothing.
//
// WHY CANADA KEEPS THE ROOT PATHS. The Canadian side is live and in daily use.
// Moving it under /ca/ would break every emailed export link and every stored
// SavedSearch.path row, and would need a data migration — all for no user-visible
// gain, since the toggle reads the same either way. So Canada stays where it is
// and America mounts alongside it at /us/*.
// ---------------------------------------------------------------------------

export type GeneticSystem = "ca" | "us";

export const GENETIC_SYSTEMS: { key: GeneticSystem; short: string; label: string; hint: string }[] = [
  { key: "ca", short: "CA", label: "Canadian", hint: "Lactanet evaluations — LPI, Pro$, EBVs in kg" },
  { key: "us", short: "US", label: "American", hint: "CDCB evaluations — TPI, PTAT, NM$, PTAs in lb" },
];

/** The path prefix a system's pages live under. Canada is the root. */
export function systemPrefix(system: GeneticSystem): string {
  return system === "us" ? "/us" : "";
}

/** Which system a pathname belongs to. */
export function systemFromPathname(pathname: string | null | undefined): GeneticSystem {
  const p = pathname ?? "";
  return p === "/us" || p.startsWith("/us/") ? "us" : "ca";
}

/**
 * Move a path to the other system, preserving the page where one exists and
 * FALLING BACK TO THAT SYSTEM'S DASHBOARD where it does not.
 *
 * The fallback is the whole point. The two sides are not mirror images: Canada
 * has pages America will never have (interim proofs, the mating program, live
 * Lactanet lookups, the whole Data In and Configuration groups). Mapping the path
 * across blindly mints URLs
 * for pages that do not exist, so the toggle would 404 from roughly half the app
 * — including every animal detail page, which is exactly where someone is most
 * likely to want the other country's view.
 *
 * Matching is on the FIRST path segment, so deep paths (/animals/abc123/edit)
 * resolve on whether that section exists rather than the exact page.
 */
export function toSystem(pathname: string, system: GeneticSystem): string {
  const bare = pathname === "/us" ? "/" : pathname.startsWith("/us/") ? pathname.slice(3) : pathname;
  const prefix = systemPrefix(system);
  const home = `${prefix}/dashboard`;
  if (bare === "/" || bare === "") return home;

  const seg = bare.split("/").filter(Boolean);
  const section = `/${seg[0] ?? ""}`;

  // THE ANIMAL PAGE IS THE IMPORTANT CASE. Both systems key off the SAME
  // Animal.id — the US side is a parallel evaluation table, not a parallel
  // animal roster — so /animals/<id> and /us/animals/<id> are the same bull.
  // Carrying the id across is what makes the toggle mean "show me this bull's
  // other evaluation" rather than "take me to a list".
  if (section === "/animals" && seg.length >= 2) {
    // Deeper Canadian sub-pages (edit, new proof, new classification) have no US
    // twin, so those land on the bull's US card rather than a dead URL.
    if (system === "us") return `/us/animals/${seg[1]}`;
    return `/animals/${seg[1]}${seg.length > 2 ? `/${seg.slice(2).join("/")}` : ""}`;
  }

  // Everything else: the section must exist on the other side at all.
  if (!routeAvailable(section, system)) return home;

  // A nested page under a shared section only crosses over if it really exists.
  if (seg.length > 1 && system === "us" && !US_NESTED_ROUTES.has(bare)) return `${prefix}${section}`;
  return `${prefix}${bare}`;
}

/**
 * Nested American pages that really exist. Anything else under a section falls
 * back to the section itself rather than minting a dead URL. (The animal detail
 * page is handled above, since it is keyed by id rather than being a fixed path.)
 */
const US_NESTED_ROUTES = new Set<string>([
  "/reports/proof-changes",
  "/reports/round-compare",
  "/reports/round-summary",
  "/admin/data-quality",
]);

/** Prefix a system-relative href, e.g. ("/animals","us") -> "/us/animals". */
export function systemHref(href: string, system: GeneticSystem): string {
  return `${systemPrefix(system)}${href}`;
}

export function systemLabel(system: GeneticSystem): string {
  return GENETIC_SYSTEMS.find((s) => s.key === system)?.label ?? system;
}

/**
 * American pages that exist TODAY. An allowlist, not a denylist, because the US
 * side is being built out page by page — showing a nav link to a route that does
 * not exist yet would just 404. Add each route here as it lands.
 */
export const US_ROUTES = new Set<string>([
  "/dashboard",
  "/animals",
  "/analysis",
  "/compare",
  "/parent-average",
  "/reports",
  "/admin/data-quality",
]);

/**
 * Pages the American side will NEVER have — these are not "not built yet".
 *
 * Rollback Resistance measures Canada's ANNUAL April re-basing; the US re-bases
 * every five years (verified: three consecutive Aprils moved the mean Ayrshire
 * bull about 2 lb of milk), so a US equivalent would be a number computed on a
 * false premise. The interim report likewise has no US meaning: CDCB ships ONE
 * file per round, with no official/interim pair for it to compare.
 */
export const US_EXCLUDED_ROUTES = new Set<string>([
  "/reports/interim-changes",
]);

/**
 * Canadian routes that do not exist.
 *
 * Canada's check is a DENYLIST — everything not listed is assumed to exist — so a
 * page that is removed has to be added here or the toggle starts minting a URL for
 * it. /specialists used to be an American-only page; it is a SEARCH, not a place,
 * and now sits inside each side's animals list as a trait picker that composes
 * with breed, role, favourites, sorting and paging. A separate ranked page could
 * honour none of those, which is precisely why it was wrong. It exists on neither
 * side, so it is denied here and simply absent from US_ROUTES.
 */
export const CA_EXCLUDED_ROUTES = new Set<string>([
  "/specialists",
]);

/** True when a system-relative route should appear in that system's nav. */
export function routeAvailable(href: string, system: GeneticSystem): boolean {
  if (system === "ca") return !CA_EXCLUDED_ROUTES.has(href);
  return US_ROUTES.has(href) && !US_EXCLUDED_ROUTES.has(href);
}
