// Shared lineup filter/sort controls + status badges.
//
// Both lineup lists — Animals (/animals) and Proof Trends · Rollback Resistance
// (/analysis, whose two tabs are Rankings and Charts & comparison) — use these,
// so the four sire roles, the Blondin toggle and the LPI / Conformation /
// birth-date sort behave identically on each. (The old global Genetic Proofs,
// Milk and Classification lists are gone; they are tabs on the animal profile.)
//
// The fields are plain form controls meant to be dropped inside an existing
// `<form method="get">`, so each page keeps its own filters alongside them.

import Link from "next/link";
import { Badge } from "@/components/ui";
import { SIRE_ROLES, SIRE_SORTS, activityLabel } from "@/lib/sire-class";

/** The four-way sire role filter: proven · genomic · active · inactive. */
export function SireRoleField({ value, name = "role" }: { value?: string | null; name?: string }) {
  return (
    <div>
      <label className="label">Sire role</label>
      <select name={name} defaultValue={value ?? ""} className="input" title="Proven / genomic come from the Lactanet proof-activity code; active / inactive from whether the sire appears in the most recent round on file.">
        <option value="">All roles</option>
        {SIRE_ROLES.map((r) => (
          <option key={r.code} value={r.code} title={r.hint}>{r.label}</option>
        ))}
      </select>
    </div>
  );
}

/** Sort by LPI, Conformation, birth date or name, plus a direction. */
export function SireSortField({ sort, dir }: { sort?: string | null; dir?: string | null }) {
  return (
    <>
      <div>
        <label className="label">Sort by</label>
        <select name="sort" defaultValue={(sort ?? "").toLowerCase()} className="input">
          <option value="">Default</option>
          {SIRE_SORTS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Order</label>
        <select name="dir" defaultValue={dir === "asc" ? "asc" : "desc"} className="input">
          <option value="desc">High → low / newest</option>
          <option value="asc">Low → high / oldest</option>
        </select>
      </div>
    </>
  );
}

/**
 * Compact status badges for a sire in a table row or profile header.
 * `activityCode` (when given) drives the tooltip with Lactanet's own wording.
 */
export function SireClassBadges({
  sireType, proofStatus, rollbackCount, activityCode, proofRoundCount, showRollbacks = true,
}: {
  sireType?: string | null;
  proofStatus?: string | null;
  rollbackCount?: number | null;
  activityCode?: string | null;
  proofRoundCount?: number | null;
  showRollbacks?: boolean;
}) {
  const lactanet = activityLabel(activityCode);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {sireType && (
        <span title={lactanet ?? undefined}>
          <Badge tone={sireType === "proven" ? "green" : "blue"}>
            {sireType === "proven" ? "Proven" : "Genomic"}
          </Badge>
        </span>
      )}
      {proofStatus && (
        <span title={proofStatus === "active" ? "Available — has a NAAB stud (semen) code" : "No NAAB stud code"}>
          <Badge tone={proofStatus === "active" ? "brand" : "slate"}>
            {proofStatus === "active" ? "Active" : "Inactive"}
          </Badge>
        </span>
      )}
      {showRollbacks && rollbackCount != null && rollbackCount > 0 && (
        <span title={`Has been through ${rollbackCount} April base change${rollbackCount === 1 ? "" : "s"} (rollback${rollbackCount === 1 ? "" : "s"})${proofRoundCount ? ` across ${proofRoundCount} proof rounds` : ""}. Every other round carries updated information.`}>
          <Badge tone="amber">{rollbackCount}× rollback</Badge>
        </span>
      )}
    </div>
  );
}

/** One pill above a list: on = solid brand, off = outlined. */
const pill = (isOn: boolean) =>
  `rounded-full px-3 py-1 text-xs font-medium ${isOn ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"}`;

/**
 * Quick role pills above a list — one click to filter, preserving the page's
 * other query params. `counts` is optional and shows how many match each role.
 */
export function SireRolePills({
  basePath, sp, counts,
}: {
  basePath: string;
  sp: Record<string, string | undefined>;
  counts?: Partial<Record<string, number>>;
}) {
  const href = (role: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "role" && k !== "page") params.set(k, v);
    if (role) params.set("role", role);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const active = sp.role ?? "";
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      <Link href={href("")} className={pill(active === "")}>All</Link>
      {SIRE_ROLES.map((r) => (
        <Link key={r.code} href={href(r.code)} className={pill(active === r.code)} title={r.hint}>
          {r.label}
          {counts?.[r.code] != null && <span className="ml-1 opacity-70">{counts[r.code]}</span>}
        </Link>
      ))}
    </div>
  );
}

/**
 * Blondin-only toggle, styled like the role pills and shown next to them.
 *
 * "All bulls" is the default and sets no param at all, so a page with no
 * `blondin` in the URL queries exactly what it always did. Paging is reset on
 * either click, and every other query param is carried across.
 */
export function BlondinToggle({
  basePath, sp,
}: {
  basePath: string;
  sp: Record<string, string | undefined>;
}) {
  const href = (v: string) => {
    const params = new URLSearchParams();
    for (const [k, val] of Object.entries(sp)) if (val && k !== "blondin" && k !== "page") params.set(k, val);
    if (v) params.set("blondin", v);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const only = sp.blondin === "1";
  const hint = "Blondin bulls are the stud's own house bulls, as opposed to the wider Lactanet population imported from the archive files.";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Lineup</span>
      <Link href={href("")} className={pill(!only)} title={hint}>All bulls</Link>
      <Link href={href("1")} className={pill(only)} title={hint}>Blondin only</Link>
    </div>
  );
}
