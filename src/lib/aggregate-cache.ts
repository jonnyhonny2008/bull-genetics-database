import "server-only";

// ---------------------------------------------------------------------------
// A small TTL cache for ROUND-LEVEL facts, shared by both countries.
//
// WHAT BELONGS HERE, AND WHAT MUST NOT. Only values that change when a round is
// imported — which round is newest, how many bulls carry each AI status, the
// per-breed averages a dashboard prints. Those are recomputed from scratch on
// every page view otherwise, and they are identical for every user between
// imports.
//
// A BULL'S OWN NUMBERS ARE NEVER CACHED. Serving a stale evaluation would be far
// worse than a slow page: someone would quote a GTPI that had already moved. The
// cost of a mistake is not symmetric here, so the cache is deliberately confined
// to aggregates that describe the ROUND rather than the animal.
//
// A DASHBOARD LEADERBOARD IS A ROUND-LEVEL FACT, not a bull's own numbers. "The
// ten highest GTPI bulls in round 2604" is a property of the round and changes
// only when the round does. What the rule forbids is a bull's CARD reading from
// a cache — that page must always show what the database currently holds.
//
// WHY IT ALSO DEDUPES IN-FLIGHT CALLS. Without that, a cold instance taking a
// burst of three requests runs the expensive query three times concurrently and
// then caches the same answer three times — on a pool pinned to ONE connection
// (see src/lib/db.ts) those three pile up head to tail and the third caller waits
// for all of them. Deduping is worth more here than the caching is.
//
// In serverless this survives only as long as the instance stays warm, which is
// exactly the case that matters — the second click, not the first.
// ---------------------------------------------------------------------------

interface Entry<T> { value: T; expires: number }

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/** Ten minutes. An import is a deliberate act, and nobody runs two in a minute. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;

  // Someone else is already computing this — wait on their call rather than
  // starting a second identical one behind it in the connection queue.
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const p = fn()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      inflight.delete(key);
      return value;
    })
    .catch((e) => {
      // A failure must not be cached, and must not wedge every later caller.
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, p);
  return p;
}

/** Drop everything. Call after an import so the next page view is not stale. */
export function clearAggregateCache(): void {
  store.clear();
  inflight.clear();
}
