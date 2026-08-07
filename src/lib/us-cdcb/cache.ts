import "server-only";

// ---------------------------------------------------------------------------
// A small TTL cache for the American side's ROUND-LEVEL facts.
//
// WHAT BELONGS HERE, AND WHAT MUST NOT. Only values that change when a round is
// imported — which round is newest, how many bulls carry each AI status. Those
// are recomputed from scratch on every page view today, and they are identical
// for every user between imports.
//
// A BULL'S OWN NUMBERS ARE NEVER CACHED. Serving a stale evaluation would be far
// worse than a slow page: someone would quote a GTPI that had already moved. The
// cost of a mistake is not symmetric here, so the cache is deliberately confined
// to aggregates that describe the ROUND rather than the animal.
//
// In serverless this survives only as long as the instance stays warm, which is
// exactly the case that matters — the second click, not the first.
// ---------------------------------------------------------------------------

interface Entry<T> { value: T; expires: number }

const store = new Map<string, Entry<unknown>>();

/** Ten minutes. An import is a deliberate act, and nobody runs two in a minute. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/** Drop everything. Call after an import so the next page view is not stale. */
export function clearUsCache(): void {
  store.clear();
}
