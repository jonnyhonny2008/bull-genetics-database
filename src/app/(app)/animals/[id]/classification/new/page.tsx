import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getAllSources } from "@/lib/reference";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { saveClassification } from "@/app/(app)/records/actions";

export const dynamic = "force-dynamic";

export default async function NewClassificationPage({ params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) redirect(`/animals/${params.id}`);
  const animal = await prisma.animal.findFirst({ where: { id: params.id, archived: false }, include: { breed: true } });
  if (!animal) notFound();
  const [defs, sources] = await Promise.all([
    prisma.traitDefinition.findMany({ where: { domain: "classification", active: true }, orderBy: { displayOrder: "asc" } }),
    getAllSources(),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add classification record" subtitle={`${animal.primaryName} · ${animal.breed?.breedName ?? "no breed"}`} />
      <form action={saveClassification} className="space-y-4">
        <input type="hidden" name="animalId" value={animal.id} />
        <Card title="Classification">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className="label">Source</label>
              <select name="sourceId" className="input" defaultValue="">
                <option value="">— none —</option>
                {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Classification date *</label>
              <input type="date" name="classificationDate" required className="input" />
            </div>
            <div>
              <label className="label">Lactation number</label>
              <input name="lactationNumber" type="number" min="1" className="input" />
            </div>
            <div>
              <label className="label">Age at classification</label>
              <input name="ageAtClassification" placeholder="e.g. 4-01" className="input" />
            </div>
            <div>
              <label className="label">Final score</label>
              <input name="finalScore" type="number" min="50" max="100" className="input" />
            </div>
            <div>
              <label className="label">Classification code</label>
              <select name="classificationCode" className="input" defaultValue="">
                <option value="">—</option>
                <option value="EX">EX — Excellent</option>
                <option value="VG">VG — Very Good</option>
                <option value="GP">GP — Good Plus</option>
                <option value="G">G — Good</option>
                <option value="F">F — Fair</option>
                <option value="P">P — Poor</option>
              </select>
            </div>
            <div>
              <label className="label">Approval status</label>
              <select name="approvalStatus" className="input" defaultValue="approved">
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>
        </Card>

        <Card title="Section / linear traits">
          <p className="mb-3 text-xs text-slate-400">Flexible trait breakdown — enter scores or linear values you have; blanks ignored.</p>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {defs.map((d) => (
              <div key={d.traitId} className="flex items-center gap-2">
                <label className="flex-1 text-sm text-slate-600" htmlFor={`ctrait_${d.traitCode}`}>{d.traitName}</label>
                <input id={`ctrait_${d.traitCode}`} name={`ctrait_${d.traitCode}`} className="input w-24" />
              </div>
            ))}
          </div>
        </Card>

        <div className="flex gap-2">
          <button type="submit" className="btn-primary">Save classification</button>
          <a href={`/animals/${animal.id}`} className="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>
  );
}
