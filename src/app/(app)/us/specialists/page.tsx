import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Badge, EmptyState, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";
import { formatUsTrait, usKeyTrait } from "@/lib/us-cdcb/key-traits";
import {
  US_SPECIALIST_TRAITS,
  US_SPECIALIST_LEVELS,
  usSpecialists,
  usSpecialistExclusions,
  usSpecialistTrait,
  parseUsSpecialistCodes,
  parseUsSpecialistLevel,
  type UsSpecialistTrait,
} from "@/lib/us-cdcb/specialists";

export const dynamic = "force-dynamic";

// The American specialist finder. Tick a few traits, get the bulls that are
// solidly positive for all of them at once.
//
// A plain GET form rather than a dropdown component: the whole state is three
// query params, so the picker needs no client JavaScript and the resulting list
// is a shareable URL — which is how these lists actually get passed around.

type SP = Record<string, string | string[] | undefined>;

export default async function UsSpecialistsPage({ searchParams }: { searchParams: SP }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) redirect("/dashboard");

  const codes = parseUsSpecialistCodes(searchParams.t);
  const level = parseUsSpecialistLevel(one(searchParams.level));
  const breed = (one(searchParams.breed) ?? "").toUpperCase();
  const levelDef = US_SPECIALIST_LEVELS.find((l) => l.code === level)!;

  let result: Awaited<ReturnType<typeof usSpecialists>> | null = null;
  let missingTables = false;
  if (codes.length) {
    try {
      result = await usSpecialists({ codes, level, breed: breed || undefined });
    } catch (e) {
      // The US tables are created by `prisma db push`. Until that has run, say so
      // plainly rather than rendering a 500 — this is a setup state, not a fault.
      if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) {
        missingTables = true;
      } else throw e;
    }
  }

  const selected = new Set(codes);
  const groups = groupTraits(US_SPECIALIST_TRAITS);
  const exclusions = usSpecialistExclusions();

  return (
    <div>
      <PageHeader
        title="American specialists"
        subtitle={
          codes.length
            ? `${levelDef.label} for ${codes.map((c) => usSpecialistTrait(c)?.name ?? c).join(", ")}`
            : "Bulls that are solidly positive for every trait you pick — CDCB PTAs, in pounds."
        }
      />

      <Card title="Pick the specialty" className="mb-4">
        <form method="get" action="/us/specialists">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs font-medium text-slate-600">
              <span className="mb-1 block">Bar</span>
              <select name="level" defaultValue={level} className="input">
                {US_SPECIALIST_LEVELS.map((l) => (
                  <option key={l.code} value={l.code}>{l.label} — {l.hint}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              <span className="mb-1 block">Breed</span>
              <select name="breed" defaultValue={breed} className="input">
                <option value="">All breeds</option>
                {CDCB_BREEDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <button type="submit" className="btn-primary btn-sm">Find specialists</button>
            {codes.length > 0 && <Link href="/us/specialists" className="btn-secondary btn-sm">Clear</Link>}
          </div>

          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(([group, list]) => (
              <div key={group}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group}</div>
                <div className="space-y-0.5">
                  {list.map((t) => (
                    <label key={t.code} className="flex items-center gap-1.5 text-xs text-slate-700">
                      <input type="checkbox" name="t" value={t.code} defaultChecked={selected.has(t.code)} />
                      <span className="truncate" title={t.unit ? `${t.name} (${t.unit})` : t.name}>{t.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </form>

        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
          The bar is <strong>zero plus a share of the pool&rsquo;s own spread</strong>. Zero is the CDCB
          genetic base, a real neutral point; the pool supplies only the scale, which is what lets one
          setting mean the same thing for Milk in pounds and Foot Angle in score points. Each breed sits on
          its own base, so leaving the breed on <em>All breeds</em> sets a single bar across several bases —
          pick a breed for a like-for-like comparison.
        </p>
      </Card>

      {missingTables ? (
        <Card title="The American tables have not been created yet">
          <p className="text-sm text-slate-600">
            The US side stores its evaluations in their own tables, separate from the Canadian ones, so a
            CDCB proof can never displace a Lactanet proof. Those tables do not exist in this database yet.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run db:push:prod</pre>
          <p className="mt-3 text-sm text-slate-600">Then import a CDCB round:</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">npm run import:cdcb:prod -- &quot;C:\path\to\cdcb\files&quot;</pre>
          <p className="mt-3 text-xs text-slate-500">Both are additive — no existing Canadian table is touched.</p>
        </Card>
      ) : !result ? (
        <EmptyState message="Tick one or more traits above, then Find specialists." />
      ) : result.rows.length === 0 ? (
        <>
          <EmptyState message={`No bull in the pool clears the bar on all ${codes.length} trait${codes.length === 1 ? "" : "s"} at once. Drop the bar to Positive, or pick fewer traits.`} />
          <BarTable result={result} />
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            <strong>{fmtNum(result.rows.length)}</strong> specialist{result.rows.length === 1 ? "" : "s"} of{" "}
            {fmtNum(result.scoredN)} bull{result.scoredN === 1 ? "" : "s"} scored for every picked trait
            {result.scoredN !== result.poolN && <> (out of {fmtNum(result.poolN)} with an official evaluation)</>}
            {result.truncated && <> — showing the top {fmtNum(result.rows.length)}</>}.
          </p>

          <div className="card">
            <Table head={<>
              <th className="th">Bull</th>
              <th className="th">Breed</th>
              {codes.map((c) => (
                <th key={c} className="th text-right" title={usSpecialistTrait(c)?.name}>
                  {usSpecialistTrait(c)?.name ?? c}
                </th>
              ))}
              <th className="th text-right" title="GTPI calculated by Blondin Sires — see the note below">GTPI (calc.)</th>
              <th className="th text-right">NM$</th>
              <th className="th">Round</th>
            </>}>
              {result.rows.map((r) => (
                <tr key={r.animalId} className="hover:bg-slate-50">
                  <td className="td">
                    <Link href={`/animals/${r.animalId}`} className="link font-medium">{r.name}</Link>
                    {r.naabCode && <span className="mt-0.5 block font-mono text-[10px] text-slate-400">NAAB {r.naabCode}</span>}
                  </td>
                  <td className="td text-xs text-slate-500">{r.evalBreed ?? "—"}</td>
                  {codes.map((c) => (
                    <td key={c} className="td text-right tabular-nums">{fmtTrait(c, r.values[c])}</td>
                  ))}
                  <td className="td text-right tabular-nums">
                    {r.tpi != null
                      ? <span title={r.tpiFormulaVersion ? `Calculated using the ${r.tpiFormulaVersion} formula` : undefined} className="font-semibold">{Math.round(r.tpi)}</span>
                      : "—"}
                  </td>
                  <td className="td text-right tabular-nums">{formatUsTrait(usKeyTrait("NM")!, r.nmDollar)}</td>
                  <td className="td text-xs text-slate-500">
                    {r.roundCode ? <Badge tone="blue">{r.roundCode}</Badge> : "—"}
                  </td>
                </tr>
              ))}
            </Table>
          </div>

          <BarTable result={result} />

          <p className="mt-3 text-xs text-slate-500">
            <strong>GTPI is calculated</strong> by Blondin Sires from CDCB evaluations using the Holstein
            Association USA formula in force for each round. It is not an official Holstein Association USA
            publication and is typically within ±3 points of the published figure. TPI is a registered
            trademark of Holstein Association USA. All values are PTAs in pounds, from official CDCB rounds
            only — the monthly and weekly runs are not ranked here.
          </p>
        </>
      )}

      <Card title="Traits that are not offered here" className="mt-4">
        <p className="mb-3 text-sm text-slate-600">
          A specialty only means something when more of the trait is plainly better. These are absent for a
          reason, not because they are missing.
        </p>
        <dl className="space-y-3">
          {exclusions.map((x) => (
            <div key={x.why}>
              <dt className="text-xs font-semibold text-slate-700">{x.traits.map((t) => t.name).join(" · ")}</dt>
              <dd className="text-xs text-slate-500">{x.why}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

/** The bar each picked trait had to clear, so the filter is never a black box. */
function BarTable({ result }: { result: NonNullable<Awaited<ReturnType<typeof usSpecialists>>> }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {result.bars.map((b) => (
        <span key={b.code} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
          <strong>{b.name}</strong>{" "}
          {b.threshold == null
            ? "— no bull in the pool carries it"
            : b.threshold === 0
              ? "≥ any positive PTA"
              : `≥ ${fmtTrait(b.code, b.threshold)}`}
          {b.sd != null && b.sd > 0 && <span className="text-slate-400"> · pool SD {fmtTrait(b.code, b.sd)}</span>}
        </span>
      ))}
    </div>
  );
}

function groupTraits(traits: UsSpecialistTrait[]): [string, UsSpecialistTrait[]][] {
  const m = new Map<string, UsSpecialistTrait[]>();
  for (const t of traits) {
    const a = m.get(t.group) ?? [];
    a.push(t);
    m.set(t.group, a);
  }
  return [...m.entries()];
}

/**
 * How many decimals a PTA is worth showing at. Yield is whole pounds; percentages
 * and the fitness traits carry one; the linear type scores carry two, where a
 * tenth is a real difference between bulls.
 */
function decimalsFor(code: string): number {
  const unit = usSpecialistTrait(code)?.unit ?? null;
  if (unit === "lb" || unit === "$") return 0;
  if (unit === null) return 2;
  return 1;
}

/** PTAs are deviations, so a negative one is a normal result and always signed. */
function fmtTrait(code: string, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(decimalsFor(code));
  return v > 0 ? `+${s}` : s;
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
