import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, SPECIES_TYPES } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { saveTrait } from "@/app/(app)/admin/actions";

export const dynamic = "force-dynamic";

export default async function TraitsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");
  const domain = searchParams.domain ?? "genetic";
  const traits = await prisma.traitDefinition.findMany({ where: { domain }, orderBy: [{ speciesType: "asc" }, { displayOrder: "asc" }] });

  return (
    <div>
      <PageHeader title="Trait Definitions" subtitle="The flexible trait catalogue drives proof and classification entry. Add breed/species-aware traits here." />
      <div className="mb-4 flex gap-2 text-sm">
        <a href="/traits?domain=genetic" className={`rounded-full px-3 py-1 ${domain === "genetic" ? "bg-brand-600 text-white" : "border border-slate-300 bg-white"}`}>Genetic</a>
        <a href="/traits?domain=classification" className={`rounded-full px-3 py-1 ${domain === "classification" ? "bg-brand-600 text-white" : "border border-slate-300 bg-white"}`}>Classification</a>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Add trait">
          <TraitForm domain={domain} />
        </Card>
        <Card title={`${domain} traits (${traits.length})`} className="lg:col-span-2">
          {traits.length === 0 ? <EmptyState message="No traits." /> : (
            <Table head={<><th className="th">Code</th><th className="th">Name</th><th className="th">Species</th><th className="th">Category</th><th className="th">Unit</th><th className="th">↑better</th><th className="th"></th></>}>
              {traits.map((t) => (
                <tr key={t.traitId}>
                  <td className="td font-mono text-xs">{t.traitCode}</td>
                  <td className="td font-medium">{t.traitName}</td>
                  <td className="td">{t.speciesType}</td>
                  <td className="td">{t.category ?? "—"}</td>
                  <td className="td">{t.unit ?? "—"}</td>
                  <td className="td">{t.higherIsBetter ? "↑" : "↓"}</td>
                  <td className="td">
                    <details>
                      <summary className="link cursor-pointer text-xs">edit</summary>
                      <div className="mt-2 w-72"><TraitForm domain={domain} trait={t} /></div>
                    </details>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function TraitForm({ domain, trait }: { domain: string; trait?: any }) {
  return (
    <form action={saveTrait} className="space-y-2">
      {trait && <input type="hidden" name="traitId" value={trait.traitId} />}
      <input type="hidden" name="domain" value={trait?.domain ?? domain} />
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label">Code</label><input name="traitCode" defaultValue={trait?.traitCode} className="input" required /></div>
        <div><label className="label">Species</label>
          <select name="speciesType" defaultValue={trait?.speciesType ?? "dairy"} className="input">
            {SPECIES_TYPES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </div>
      </div>
      <div><label className="label">Name</label><input name="traitName" defaultValue={trait?.traitName} className="input" required /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label">Category</label><input name="category" defaultValue={trait?.category ?? ""} className="input" /></div>
        <div><label className="label">Unit</label><input name="unit" defaultValue={trait?.unit ?? ""} className="input" /></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label">Display order</label><input name="displayOrder" type="number" defaultValue={trait?.displayOrder ?? 0} className="input" /></div>
        <label className="flex items-end gap-2 text-sm"><input type="checkbox" name="higherIsBetter" defaultChecked={trait ? trait.higherIsBetter : true} /> Higher is better</label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={trait ? trait.active : true} /> Active</label>
      <button type="submit" className="btn-primary btn-sm">{trait ? "Save" : "Add trait"}</button>
    </form>
  );
}
