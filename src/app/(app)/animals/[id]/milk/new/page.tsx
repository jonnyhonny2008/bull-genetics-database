import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card } from "@/components/ui";
import { saveMilk } from "@/app/(app)/records/actions";

export const dynamic = "force-dynamic";

export default async function NewMilkPage({ params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) redirect(`/animals/${params.id}`);
  const animal = await prisma.animal.findUnique({ where: { id: params.id }, include: { breed: true } });
  if (!animal) notFound();
  const sources = await prisma.source.findMany({ orderBy: { sourceName: "asc" } });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add milk record" subtitle={`${animal.primaryName} · ${animal.breed?.breedName ?? "no breed"}`} />
      <form action={saveMilk} className="space-y-4">
        <input type="hidden" name="animalId" value={animal.id} />
        <Card title="Production record">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className="label">Source</label>
              <select name="sourceId" className="input" defaultValue="">
                <option value="">— none —</option>
                {sources.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.sourceName}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Record date *</label>
              <input type="date" name="recordDate" required className="input" />
            </div>
            <div>
              <label className="label">Lactation number</label>
              <input name="lactationNumber" type="number" min="1" className="input" />
            </div>
            <div>
              <label className="label">Calving date</label>
              <input type="date" name="calvingDate" className="input" />
            </div>
            <div>
              <label className="label">Days in milk</label>
              <input name="daysInMilk" type="number" defaultValue={305} className="input" />
            </div>
            <div>
              <label className="label">Record type</label>
              <select name="recordType" className="input" defaultValue="305d">
                <option value="305d">305-day</option>
                <option value="lactation">Full lactation</option>
                <option value="test_day">Test day</option>
                <option value="projected">Projected</option>
              </select>
            </div>
            <div>
              <label className="label">Milk (kg) </label>
              <input name="milkAmount" type="number" step="0.1" className="input" />
            </div>
            <div>
              <label className="label">Fat (kg)</label>
              <input name="fatAmount" type="number" step="0.1" className="input" />
            </div>
            <div>
              <label className="label">Fat %</label>
              <input name="fatPercent" type="number" step="0.01" className="input" />
            </div>
            <div>
              <label className="label">Protein (kg)</label>
              <input name="proteinAmount" type="number" step="0.1" className="input" />
            </div>
            <div>
              <label className="label">Protein %</label>
              <input name="proteinPercent" type="number" step="0.01" className="input" />
            </div>
            <div>
              <label className="label">Completion</label>
              <select name="completionStatus" className="input" defaultValue="complete">
                <option value="complete">Complete</option>
                <option value="in_progress">In progress</option>
                <option value="projected">Projected</option>
              </select>
            </div>
            <div>
              <label className="label">Approval status</label>
              <select name="approvalStatus" className="input" defaultValue="approved">
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="label">Notes</label>
              <input name="notes" className="input" />
            </div>
          </div>
        </Card>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary">Save milk record</button>
          <a href={`/animals/${animal.id}`} className="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>
  );
}
