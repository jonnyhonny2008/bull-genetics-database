import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getActiveBreeds, getAllSources } from "@/lib/reference";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader } from "@/components/ui";
import { AnimalForm } from "../../AnimalForm";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function EditAnimalPage({ params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "animal:write")) redirect(`/animals/${params.id}`);

  const [animal, breeds, sources] = await Promise.all([
    prisma.animal.findFirst({ where: { id: params.id, archived: false }, include: { identifiers: true } }),
    getActiveBreeds(),
    getAllSources(),
  ]);
  if (!animal) notFound();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={`Edit — ${animal.primaryName}`} subtitle="Editing replaces the identifier list with what you save here. Sire role is derived from imported proofs and is not editable." />
      <AnimalForm
        breeds={breeds}
        sources={sources}
        animal={{
          id: animal.id,
          primaryName: animal.primaryName,
          shortName: animal.shortName,
          sex: animal.sex,
          breedId: animal.breedId,
          birthDate: animal.birthDate ? fmtDate(animal.birthDate) : null,
          countryOfOrigin: animal.countryOfOrigin,
          currentStatus: animal.currentStatus,
          notes: animal.notes,
          identifiers: animal.identifiers.map((i) => ({
            idType: i.idType, idValue: i.idValue, issuingCountry: i.issuingCountry ?? "",
            issuingOrganization: i.issuingOrganization ?? "", sourceId: i.sourceId ?? "", isPrimary: i.isPrimary,
          })),
        }}
      />
    </div>
  );
}
