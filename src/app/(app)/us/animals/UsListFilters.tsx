// Controls above the American lineup list: free-text search, the role pills and
// the favourites toggle. All three are plain server-rendered links and a native
// GET form — no client JS, so they behave the same way the breed pills already do
// and the whole filter state stays in the URL where a saved search can capture it.

import Link from "next/link";
import { US_LIST_ROLES } from "@/lib/us-cdcb/list-filters";
import { usRoundLabel } from "@/lib/us-cdcb/proof-change";

type SP = Record<string, string | undefined>;

const BASE = "/us/animals";

/** Carry every current param except the ones being changed. Paging always resets. */
function carry(sp: SP, drop: string[]): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && k !== "page" && !drop.includes(k)) p.set(k, v);
  return p;
}

function hrefWith(sp: SP, drop: string[], set?: [string, string]): string {
  const p = carry(sp, drop);
  if (set && set[1]) p.set(set[0], set[1]);
  const qs = p.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

/** One pill: on = solid brand, off = outlined. Matches the Canadian list's pills. */
const pill = (on: boolean) =>
  `rounded-full px-3 py-1 text-xs font-medium ${on ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`;

/**
 * Free-text search. The `q` parameter was already honoured server-side but had no
 * input rendered, so it was reachable only by hand-editing the URL.
 */
export function UsAnimalSearch({ sp }: { sp: SP }) {
  // Everything except q and page rides along as hidden fields, so searching does
  // not silently drop the breed or role the user already picked.
  const hidden = Object.entries(sp).filter(([k, v]) => v && k !== "q" && k !== "page");
  return (
    <form method="get" action={BASE} className="mb-3 flex flex-wrap items-end gap-2">
      {hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v as string} />)}
      <div>
        <label className="label" htmlFor="us-animal-q">Search</label>
        <input
          id="us-animal-q"
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Name, NAAB code or CDCB id"
          className="input w-72"
        />
      </div>
      <button type="submit" className="btn-secondary btn-sm">Search</button>
      {sp.q && (
        <Link href={hrefWith(sp, ["q"])} className="pb-2 text-xs text-slate-500 hover:text-brand-700">
          Clear “{sp.q}”
        </Link>
      )}
    </form>
  );
}

/**
 * The role pills. Two come from the evaluation basis and always apply; three come
 * from CDCB's AI-status file and are hidden entirely when no status file has been
 * imported — three pills all reading zero would look like an empty lineup rather
 * than a missing file.
 */
export function UsRolePills({
  sp,
  counts,
  statusRound,
}: {
  sp: SP;
  counts: Record<string, number>;
  statusRound: string | null;
}) {
  const active = sp.role ?? "";
  const roles = US_LIST_ROLES.filter((r) => r.kind === "basis" || statusRound);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Role</span>
      <Link href={hrefWith(sp, ["role"])} className={pill(active === "")}>All</Link>
      {roles.map((r) => (
        <Link
          key={r.code}
          href={hrefWith(sp, ["role"], ["role", r.code])}
          className={pill(active === r.code)}
          title={r.kind === "status" && statusRound ? `${r.hint} (as of the ${usRoundLabel(statusRound)} status file)` : r.hint}
        >
          {r.label}
          {counts[r.code] != null && <span className="ml-1 opacity-70">{counts[r.code]}</span>}
        </Link>
      ))}
    </div>
  );
}

/**
 * "My favourites". The star is a Watchlist row keyed (userId, animalId) with no
 * system on it, so this filter and the Canadian one see exactly the same set —
 * that is the point, not an accident.
 */
export function UsFavouritesToggle({ sp, signedIn }: { sp: SP; signedIn: boolean }) {
  if (!signedIn) return null;
  const on = sp.fav === "1";
  return (
    <Link
      href={on ? hrefWith(sp, ["fav"]) : hrefWith(sp, ["fav"], ["fav", "1"])}
      title="Favourites are shared with the Canadian list — a bull starred there is starred here."
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition ${
        on ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-300 text-slate-600 hover:border-amber-300 hover:text-amber-700"
      }`}
    >
      {on ? "★ Showing your favourites" : "☆ My favourites"}
    </Link>
  );
}
