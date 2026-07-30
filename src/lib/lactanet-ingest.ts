import "server-only";

// ---------------------------------------------------------------------------
// One-stop ingest from Lactanet Genetics: fetch an animal's tabs, parse them,
// upsert identity + identifiers, store the rich profile, recompute preferred.
//
// Mirrors holstein-ingest.ts so the calling code (on-demand lookup, bulk paste
// import) is unchanged in shape — but needs no browser, so it runs on Vercel.
//
// Scope note: this fills the PROFILE (pedigree, progeny, classification for
// cows, lactations for cows). Genetic evaluations still come from the official
// Lactanet bull-proof CSV importer, which is untouched — this deliberately does
// not write evaluations or traits.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import { fetchLactanetAnimal, parseReg, type LactanetFetchResult } from "./lactanet-web";
import { parseLactanetAnimal } from "./lactanet-parse";
import { storeHolsteinProfile } from "./holstein-import";
import { recomputePreferredForAnimal } from "./priority";
import { packTraits } from "./eval-traits";

export interface LactanetIngestDeps {
  breedId: string | null;
  lactanetSourceId: string | null;
  userId?: string | null;
}

let depsCache: Omit<LactanetIngestDeps, "userId"> | null = null;
export async function resolveLactanetDeps(userId?: string | null): Promise<LactanetIngestDeps> {
  if (!depsCache) {
    const [holstein, lactanet] = await Promise.all([
      prisma.breed.findUnique({ where: { breedCode: "HO" } }),
      prisma.source.findUnique({ where: { sourceName: "LactanetGen" } }),
    ]);
    depsCache = { breedId: holstein?.breedId ?? null, lactanetSourceId: lactanet?.sourceId ?? null };
  }
  return { ...depsCache, userId };
}

export interface LactanetIngestOutcome {
  reg: string;
  ok: boolean;
  animalId?: string;
  name?: string | null;
  created?: boolean;
  traitCount?: number;
  proofRun?: string | null;
  ancestors?: number;
  progeny?: number;
  classifications?: number;
  lactations?: number;
  warnings?: string[];
  error?: string;
}

/** Fetch + parse + import one registration number from Lactanet. */
export async function ingestLactanetReg(
  regRaw: string,
  userId?: string | null,
): Promise<LactanetIngestOutcome> {
  const ref = parseReg(regRaw);
  const R = ref?.reg ?? regRaw.trim().toUpperCase();
  if (!ref) {
    return { reg: R, ok: false, error: `"${regRaw}" is not a registration number (expected e.g. HOCANM13486161).` };
  }

  let fetched: LactanetFetchResult;
  try {
    fetched = await fetchLactanetAnimal(R);
  } catch (e) {
    return { reg: R, ok: false, error: `fetch failed: ${(e as Error)?.message ?? e}` };
  }
  if (fetched.error) return { reg: R, ok: false, error: fetched.error };

  const parsed = parseLactanetAnimal(R, ref.sex, fetched.tabs, fetched.fetchedAt);
  const deps = await resolveLactanetDeps(userId);

  try {
    // Keep the raw pages so a parser improvement can be re-run without refetching.
    const capture = await prisma.sourceCapture.create({
      data: {
        sourceId: deps.lactanetSourceId ?? undefined,
        captureType: "lactanet_query",
        sourceUrl: `https://www.lactanetgen.ca/query/summary.php?breed=${ref.breed}&country=${ref.country}&sex=${ref.sex}&regnum=${ref.regnum}`,
        capturedById: userId ?? undefined,
        extractionStatus: "extracted",
        confidenceScore: 0.95,
        rawExtractedDataJson: JSON.stringify({ ref, tabs: fetched.tabs, errors: fetched.errors, fetchedAt: fetched.fetchedAt }),
        notes: `Lactanet Genetics query for ${R}`,
      },
    });

    // --- upsert the animal on its registration identifier ---
    const existing = await prisma.animalIdentifier.findFirst({
      where: { idValue: R, animal: { archived: false } },
      select: { animalId: true },
    });

    const name = parsed.identity.name ?? R;
    const birthDate = parsed.identity.birthDate ? new Date(parsed.identity.birthDate) : undefined;
    let animalId: string;
    let created = false;

    if (existing) {
      animalId = existing.animalId;
      await prisma.animal.update({
        where: { id: animalId },
        data: {
          // Only fill blanks — never clobber curated values with scraped ones.
          shortName: parsed.identity.shortName ?? undefined,
          birthDate,
          updatedById: userId ?? undefined,
        },
      });
    } else {
      const a = await prisma.animal.create({
        data: {
          primaryName: name,
          shortName: parsed.identity.shortName ?? undefined,
          sex: ref.sex,
          breedId: deps.breedId ?? undefined,
          birthDate,
          countryOfOrigin: ref.country === "CAN" ? "CA" : ref.country === "USA" ? "US" : "INT",
          createdById: userId ?? undefined,
          updatedById: userId ?? undefined,
        },
        select: { id: true },
      });
      animalId = a.id;
      created = true;
      await prisma.animalIdentifier.create({
        data: {
          animalId, idType: "registration_ca", idValue: R, isPrimary: true, active: true,
          issuingCountry: ref.country, sourceId: deps.lactanetSourceId ?? undefined,
        },
      });
    }

    // NAAB / semen code, when the summary carried one.
    if (parsed.identity.naab) {
      const has = await prisma.animalIdentifier.findFirst({
        where: { animalId, idType: "naab", idValue: parsed.identity.naab },
        select: { identifierId: true },
      });
      if (!has) {
        await prisma.animalIdentifier.create({
          data: { animalId, idType: "naab", idValue: parsed.identity.naab, active: true, sourceId: deps.lactanetSourceId ?? undefined },
        });
      }
    }

    await prisma.sourceCapture.update({ where: { captureId: capture.captureId }, data: { animalId } });

    // --- genetic evaluation -------------------------------------------------
    // Upsert by (animal, proof run): re-running a lookup refreshes that round
    // instead of stacking duplicate rows, which would corrupt proof-round counts
    // and the Proof Change Report's "previous official proof" pick.
    let traitCount = 0;
    const ev = parsed.evaluation;
    if (ev.traits.length && ev.runDate) {
      const packed = packTraits(
        ev.traits.map((t) => ({
          traitCode: t.code, numericValue: t.numericValue, textValue: t.textValue,
          reliability: t.reliability, percentileRank: t.percentileRank,
        })),
      );
      const evaluationDate = new Date(`${ev.runDate}T00:00:00Z`);
      const existingEval = await prisma.geneticEvaluation.findFirst({
        where: { animalId, evaluationDate, sourceId: deps.lactanetSourceId ?? undefined },
        select: { evaluationId: true },
      });
      const data = {
        evaluationDate,
        proofRun: ev.runLabel ?? undefined,
        countrySystem: "CA",
        breedContext: "Holstein",
        reliabilityOverall: ev.reliability,
        approvalStatus: "approved",
        traitsJson: packed.traitsJson,
        ...packed.columns,
        notes: `Lactanet Genetics query${ev.basis ? ` (${ev.basis})` : ""}.`,
      };
      if (existingEval) {
        await prisma.geneticEvaluation.update({ where: { evaluationId: existingEval.evaluationId }, data });
      } else {
        await prisma.geneticEvaluation.create({
          data: {
            ...data, animalId,
            sourceId: deps.lactanetSourceId ?? undefined,
            captureId: capture.captureId,
            createdById: userId ?? undefined,
          },
        });
      }
      traitCount = ev.traits.length;
    }

    // Rich profile — same shape the Holstein.ca path produced, so the UI is unchanged.
    const stored = await storeHolsteinProfile(prisma, animalId, parsed.profile, {
      holCanadaSourceId: deps.lactanetSourceId,
      userId: deps.userId,
    });
    await recomputePreferredForAnimal(animalId);

    return {
      reg: R, ok: true, animalId, name, created,
      traitCount,
      proofRun: ev.runLabel,
      ancestors: parsed.profile.familyTree.length,
      progeny: parsed.profile.progeny.length,
      classifications: stored.classifications,
      lactations: stored.lactations,
      warnings: parsed.warnings,
    };
  } catch (e) {
    return { reg: R, ok: false, name: parsed.identity.name ?? null, error: `import failed: ${(e as Error)?.message ?? e}` };
  }
}
