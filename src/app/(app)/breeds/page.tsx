import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, SPECIES_TYPES } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { saveBreed } from "@/app/(app)/admin/actions";

export const dynamic = "force-dynamic";

export default async function BreedsPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");
  const breeds = await prisma.breed.findMany({ orderBy: { breedName: "asc" }, include: { _count: { select: { animals: true, traitDefinitions: true } } } });

  return (
    <div>
      <PageHeader title="Breeds" subtitle="Add or edit breeds. New breeds become available across the app immediately." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Add breed">
          <BreedForm />
        </Card>
        <Card title={`Breeds (${breeds.length})`} className="lg:col-span-2">
          {breeds.length === 0 ? <EmptyState message="No breeds." /> : (
            <Table head={<><th className="th">Code</th><th className="th">Name</th><th className="th">Species</th><th className="th">Animals</th><th className="th">Active</th><th className="th"></th></>}>
              {breeds.map((b) => (
                <tr key={b.breedId}>
                  <td className="td font-mono text-xs">{b.breedCode}</td>
                  <td className="td font-medium">{b.breedName}</td>
                  <td className="td">{b.speciesType}</td>
                  <td className="td">{b._count.animals}</td>
                  <td className="td">{b.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</td>
                  <td className="td">
                    <details>
                      <summary className="link cursor-pointer text-xs">edit</summary>
                      <div className="mt-2 w-72"><BreedForm breed={b} /></div>
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

function BreedForm({ breed }: { breed?: any }) {
  return (
    <form action={saveBreed} className="space-y-2">
      {breed && <input type="hidden" name="breedId" value={breed.breedId} />}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Code</label>
          <input name="breedCode" defaultValue={breed?.breedCode} className="input" required />
        </div>
        <div>
          <label className="label">Species</label>
          <select name="speciesType" defaultValue={breed?.speciesType ?? "dairy"} className="input">
            {SPECIES_TYPES.filter((s) => s.code !== "both").map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Name</label>
        <input name="breedName" defaultValue={breed?.breedName} className="input" required />
      </div>
      <div>
        <label className="label">Registry organization</label>
        <input name="registryOrganization" defaultValue={breed?.registryOrganization ?? ""} className="input" />
      </div>
      <input type="hidden" name="breedCategory" value={breed?.breedCategory ?? ""} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={breed ? breed.active : true} /> Active</label>
      <button type="submit" className="btn-primary btn-sm">{breed ? "Save" : "Add breed"}</button>
    </form>
  );
}
