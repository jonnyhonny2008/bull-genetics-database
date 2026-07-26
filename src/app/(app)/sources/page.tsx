import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, SOURCE_TYPES, DATA_DOMAINS, label } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { saveSource, savePriorityRule, deletePriorityRule } from "@/app/(app)/admin/actions";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");

  const [sources, rules] = await Promise.all([
    prisma.source.findMany({ orderBy: { defaultPriorityRank: "asc" } }),
    prisma.sourcePriorityRule.findMany({ include: { source: true, breed: true }, orderBy: [{ dataDomain: "asc" }, { priorityRank: "asc" }] }),
  ]);
  const rulesByDomain = new Map<string, typeof rules>();
  for (const r of rules) { const a = rulesByDomain.get(r.dataDomain) ?? []; a.push(r); rulesByDomain.set(r.dataDomain, a); }

  return (
    <div>
      <PageHeader title="Sources & Priority Rules" subtitle="Sources are where data comes from. Priority rules decide which conflicting value becomes the preferred one (rank 1 = most preferred)." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Add source">
          <SourceForm />
        </Card>
        <Card title={`Sources (${sources.length})`} className="lg:col-span-2">
          <Table head={<><th className="th">Name</th><th className="th">Type</th><th className="th">Default rank</th><th className="th">Active</th><th className="th"></th></>}>
            {sources.map((s) => (
              <tr key={s.sourceId}>
                <td className="td font-medium">{s.sourceName}</td>
                <td className="td text-xs">{label(SOURCE_TYPES, s.sourceType)}</td>
                <td className="td">{s.defaultPriorityRank}</td>
                <td className="td">{s.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</td>
                <td className="td"><details><summary className="link cursor-pointer text-xs">edit</summary><div className="mt-2 w-72"><SourceForm source={s} /></div></details></td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <div className="mt-4">
        <PageHeader title="Source priority rules" subtitle="One ranked list per data domain." />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {DATA_DOMAINS.map((d) => (
            <Card key={d.code} title={d.label}>
              {(rulesByDomain.get(d.code) ?? []).length === 0 ? <EmptyState message="No rules — sources fall back to their default rank." /> : (
                <ol className="mb-3 space-y-1">
                  {(rulesByDomain.get(d.code) ?? []).map((r) => (
                    <li key={r.ruleId} className="flex items-center gap-2 text-sm">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800">{r.priorityRank}</span>
                      <span className="flex-1">{r.source.sourceName}{r.breed ? <span className="text-xs text-slate-400"> · {r.breed.breedName}</span> : ""}</span>
                      <form action={deletePriorityRule}><input type="hidden" name="ruleId" value={r.ruleId} /><button className="text-xs text-red-600 hover:underline" type="submit">remove</button></form>
                    </li>
                  ))}
                </ol>
              )}
              <form action={savePriorityRule} className="flex items-end gap-2 border-t border-slate-100 pt-2">
                <input type="hidden" name="dataDomain" value={d.code} />
                <input type="hidden" name="active" value="1" />
                <div className="flex-1">
                  <label className="label">Source</label>
                  <select name="sourceId" className="input" required>
                    <option value="">Choose…</option>
                    {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
                  </select>
                </div>
                <div className="w-20">
                  <label className="label">Rank</label>
                  <input name="priorityRank" type="number" min="1" className="input" required />
                </div>
                <button className="btn-secondary btn-sm" type="submit">Add</button>
              </form>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function SourceForm({ source }: { source?: any }) {
  return (
    <form action={saveSource} className="space-y-2">
      {source && <input type="hidden" name="sourceId" value={source.sourceId} />}
      <div><label className="label">Name</label><input name="sourceName" defaultValue={source?.sourceName} className="input" required /></div>
      <div><label className="label">Type</label>
        <select name="sourceType" defaultValue={source?.sourceType ?? "manual"} className="input">
          {SOURCE_TYPES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label">Base URL</label><input name="baseUrl" defaultValue={source?.baseUrl ?? ""} className="input" /></div>
        <div><label className="label">Default rank</label><input name="defaultPriorityRank" type="number" defaultValue={source?.defaultPriorityRank ?? 50} className="input" /></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={source ? source.active : true} /> Active</label>
      <button type="submit" className="btn-primary btn-sm">{source ? "Save" : "Add source"}</button>
    </form>
  );
}
