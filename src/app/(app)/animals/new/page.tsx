import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getActiveBreeds, getAllSources } from "@/lib/reference";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader } from "@/components/ui";
import { AnimalForm } from "../AnimalForm";

export const dynamic = "force-dynamic";

export default async function NewAnimalPage() {
  const user = currentUser();
  if (!can(user?.role, "animal:write")) redirect("/animals");
  const [breeds, sources] = await Promise.all([
    getActiveBreeds(),
    getAllSources(),
  ]);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="New animal" subtitle="Create a central animal record. Identifiers and roles are attached below." />
      <AnimalForm breeds={breeds} sources={sources} />
    </div>
  );
}
