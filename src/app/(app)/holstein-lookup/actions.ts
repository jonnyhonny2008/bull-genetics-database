"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { recomputePreferredForAnimal } from "@/lib/priority";
import { parseHolsteinAis, parseHolsteinExtract, buildAisUrl, type HolsteinRawExtract } from "@/lib/holstein";
import { importParsedHolstein, type HolsteinImportDeps } from "@/lib/holstein-import";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Resolve the breed/source ids the upsert needs (shared by both flows).
async function resolveDeps(userId?: string | null): Promise<Omit<HolsteinImportDeps, "captureId" | "animalIdParam">> {
  const [holstein, lactanet, holCanada] = await Promise.all([
    prisma.breed.findUnique({ where: { breedCode: "HO" } }),
    prisma.source.findUnique({ where: { sourceName: "LactanetGen" } }),
    prisma.source.findUnique({ where: { sourceName: "Holstein Canada" } }),
  ]);
  return { breedId: holstein?.breedId ?? null, lactanetSourceId: lactanet?.sourceId ?? null, holCanadaSourceId: holCanada?.sourceId ?? null, userId };
}

// -------------------------------------------------------------------------
// Single animal: user pasted one AIS page from their browser.
// -------------------------------------------------------------------------
export async function importHolsteinPaste(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized to import records.");

  const pasted = String(fd.get("pageText") ?? "").trim();
  const regInput = String(fd.get("regNo") ?? "").trim();
  const animalIdParam = String(fd.get("holsteinAnimalId") ?? "").trim();
  if (!pasted) throw new Error("Paste the Holstein.ca page content first.");

  const parsed = parseHolsteinAis(pasted);
  const regNo = parsed.regNo ?? regInput;
  if (!regNo) throw new Error("Could not find a registration number in the pasted page.");

  const deps = await resolveDeps(user?.uid);
  const capture = await prisma.sourceCapture.create({
    data: {
      sourceId: deps.holCanadaSourceId ?? undefined, captureType: "browser_lookup", sourceUrl: buildAisUrl(regNo, animalIdParam || undefined),
      capturedById: user?.uid, extractionStatus: "extracted", confidenceScore: 0.9,
      rawExtractedDataJson: JSON.stringify(parsed), notes: `Holstein.ca AIS paste for ${regNo}`,
    },
  });

  const res = await importParsedHolstein(prisma, parsed, regNo, { ...deps, captureId: capture.captureId, animalIdParam: animalIdParam || null });
  await recomputePreferredForAnimal(res.animalId);
  await audit(user, "animal", "import", res.animalId, { source: "Holstein.ca (paste)", regNo, traits: parsed.traits.length, warnings: parsed.warnings });

  revalidatePath("/animals");
  redirect(`/animals/${res.animalId}`);
}

// -------------------------------------------------------------------------
// Bulk: user uploads the JSON batch produced by scripts/holstein-extract.js.
// Imports every animal in one pass, then reports a summary.
// -------------------------------------------------------------------------
export async function importHolsteinBatch(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized to import records.");

  const file = fd.get("batch") as File | null;
  const pasted = String(fd.get("batchJson") ?? "").trim();
  let text = pasted;
  if (!text && file && typeof file.text === "function") text = (await file.text()).trim();
  if (!text) throw new Error("Upload the scraper's holstein-batch-*.json file (or paste its contents).");

  let records: HolsteinRawExtract[];
  try {
    const json = JSON.parse(text);
    records = Array.isArray(json) ? json : [json];
  } catch {
    throw new Error("That file isn't valid JSON — upload the holstein-batch-*.json produced by the scraper.");
  }
  if (!records.length) throw new Error("The batch file has no records.");

  const deps = await resolveDeps(user?.uid);
  const capture = await prisma.sourceCapture.create({
    data: {
      sourceId: deps.holCanadaSourceId ?? undefined, captureType: "browser_lookup",
      originalFileName: (file && file.name) || "holstein-batch.json",
      capturedById: user?.uid, extractionStatus: "extracted", confidenceScore: 0.95,
      notes: `Holstein.ca batch scrape — ${records.length} animal(s)`,
    },
  });

  let total = 0, created = 0, evals = 0, cls = 0, errors = 0, skipped = 0;
  const animalIds = new Set<string>();
  for (const rec of records) {
    if ((!rec.mainText || !rec.mainText.trim()) && rec.error) { skipped++; continue; }
    try {
      const parsed = parseHolsteinExtract(rec);
      const res = await importParsedHolstein(prisma, parsed, rec.reg ?? "", { ...deps, captureId: capture.captureId, animalIdParam: rec.animalId ?? null });
      total++; if (res.created) created++; if (res.evaluationWritten) evals++; if (res.classificationWritten) cls++;
      animalIds.add(res.animalId);
    } catch { errors++; }
  }
  for (const id of animalIds) await recomputePreferredForAnimal(id);

  await audit(user, "system", "import", capture.captureId, { source: "Holstein.ca (batch)", total, created, evals, cls, errors, skipped });

  revalidatePath("/animals");
  const q = new URLSearchParams({ imported: String(total), created: String(created), evals: String(evals), cls: String(cls), errors: String(errors), skipped: String(skipped) });
  redirect(`/holstein-lookup?${q.toString()}`);
}
