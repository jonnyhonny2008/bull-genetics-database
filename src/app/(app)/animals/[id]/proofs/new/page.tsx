import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, COUNTRIES } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { saveProof } from "@/app/(app)/records/actions";

export const dynamic = "force-dynamic";

export default async function NewProofPage({ params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) redirect(`/animals/${params.id}`);

  const animal = await prisma.animal.findFirst({ where: { id: params.id, archived: false }, include: { breed: true } });
  if (!animal) notFound();

  const species = animal.breed?.speciesType ?? "dairy";
  const [defs, sources] = await Promise.all([
    prisma.traitDefinition.findMany({
      where: { domain: "genetic", active: true, OR: [{ speciesType: species }, { speciesType: "both" }] },
      orderBy: { displayOrder: "asc" },
    }),
    prisma.source.findMany({ orderBy: { sourceName: "asc" } }),
  ]);

  const byCat = new Map<string, typeof defs>();
  for (const d of defs) {
    const c = d.category ?? "Other";
    const arr = byCat.get(c) ?? [];
    arr.push(d);
    byCat.set(c, arr);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Add genetic proof" subtitle={`${animal.primaryName} · ${animal.breed?.breedName ?? "no breed"} (${species})`} />
      <form action={saveProof} className="space-y-4">
        <input type="hidden" name="animalId" value={animal.id} />
        <Card title="Evaluation">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className="label">Source</label>
              <select name="sourceId" className="input" defaultValue="">
                <option value="">— none —</option>
                {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Evaluation date *</label>
              <input type="date" name="evaluationDate" required className="input" />
            </div>
            <div>
              <label className="label">Proof run</label>
              <input name="proofRun" placeholder="e.g. April 2026" className="input" />
            </div>
            <div>
              <label className="label">Country system</label>
              <select name="countrySystem" className="input" defaultValue={animal.countryOfOrigin ?? "CA"}>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Overall reliability (0–1)</label>
              <input name="reliability" type="number" step="0.01" min="0" max="1" placeholder="0.90" className="input" />
            </div>
            <div>
              <label className="label">Approval status</label>
              <select name="approvalStatus" className="input" defaultValue="approved">
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
              </select>
            </div>
            <div className="md:col-span-3">
              <label className="label">Notes</label>
              <input name="notes" className="input" />
            </div>
          </div>
        </Card>

        <Card title="Trait values" >
          <p className="mb-3 text-xs text-slate-400">Enter only the traits you have. Blank fields are ignored. Trait set is filtered to the animal&apos;s species.</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[...byCat.entries()].map(([cat, list]) => (
              <div key={cat} className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{cat}</div>
                <div className="space-y-2">
                  {list.map((d) => (
                    <div key={d.traitId} className="flex items-center gap-2">
                      <label className="flex-1 text-sm text-slate-600" htmlFor={`trait_${d.traitCode}`}>{d.traitName}{d.unit ? <span className="text-xs text-slate-400"> ({d.unit})</span> : null}</label>
                      <input id={`trait_${d.traitCode}`} name={`trait_${d.traitCode}`} className="input w-24" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="flex gap-2">
          <button type="submit" className="btn-primary">Save proof</button>
          <a href={`/animals/${animal.id}`} className="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>
  );
}
