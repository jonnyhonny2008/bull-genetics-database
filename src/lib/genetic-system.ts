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
 * Move a path to the other system, preserving the page where one exists.
 * `/animals` <-> `/us/animals`.
 */
export function toSystem(pathname: string, system: GeneticSystem): string {
  const bare = pathname === "/us" ? "/" : pathname.startsWith("/us/") ? pathname.slice(3) : pathname;
  const prefix = systemPrefix(system);
  if (bare === "/" || bare === "") return prefix || "/dashboard";
  return `${prefix}${bare}`;
}

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
  "/specialists",
  "/reports",
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
 * Routes that exist ONLY on the American side.
 *
 * Specialists is its own page here because the US trait vocabulary and its
 * SD-relative thresholds differ from the Canadian ones; on the Canadian side the
 * equivalent is a picker embedded in the animals list, so there is no /specialists
 * page to link to and offering one would 404.
 */
export const CA_EXCLUDED_ROUTES = new Set<string>([
  "/specialists",
]);

/** True when a system-relative route should appear in that system's nav. */
export function routeAvailable(href: string, system: GeneticSystem): boolean {
  if (system === "ca") return !CA_EXCLUDED_ROUTES.has(href);
  return US_ROUTES.has(href) && !US_EXCLUDED_ROUTES.has(href);
}
