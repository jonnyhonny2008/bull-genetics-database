import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader } from "@/components/ui";
import MatingCalculator from "./MatingCalculator";

export const dynamic = "force-dynamic";

export default function ParentAveragePage() {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Parent Average Calculator"
        subtitle="Project a mating: enter a dam and one sire for a full progeny card, or up to five sires to compare against the same dam. Each animal is taken from the database, or looked up live from Lactanet — useful for a young, non-genotyped female whose own record isn't published."
      />
      <MatingCalculator />
    </div>
  );
}
