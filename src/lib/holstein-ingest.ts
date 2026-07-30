import "server-only";

// ---------------------------------------------------------------------------
// One-stop server ingest: scrape an animal from Holstein.ca (real browser),
// parse it, upsert into the DB, and recompute preferred flags. Used by the
// in-app on-demand search and CSV import API routes. The full multi-tab scrape
// is stored on the SourceCapture (rawExtractedDataJson) so the extra tabs
// (conformation, family tree, owners, progeny) can be parsed later without
// re-scraping.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import { parseHolsteinExtract, parseHolsteinProfile } from "./holstein-parse";
import { importParsedHolstein, storeHolsteinProfile, type HolsteinImportDeps } from "./holstein-import";
import { recomputePreferredForAnimal } from "./priority";
import { scrapeHolsteinAnimal, type ScrapeResult } from "./holstein-browser";

export interface IngestDeps extends Omit<HolsteinImportDeps, "captureId" | "animalIdParam"> {}

let depsCache: IngestDeps | null = null;
export async function resolveIngestDeps(userId?: string | null): Promise<IngestDeps> {
  if (depsCache) return { ...depsCache, userId };
  const [holstein, lactanet, holCanada] = await Promise.all([
    prisma.breed.findUnique({ where: { breedCode: "HO" } }),
    prisma.source.findUnique({ where: { sourceName: "LactanetGen" } }),
    prisma.source.findUnique({ where: { sourceName: "Holstein Canada" } }),
  ]);
  depsCache = { breedId: holstein?.breedId ?? null, lactanetSourceId: lactanet?.sourceId ?? null, holCanadaSourceId: holCanada?.sourceId ?? null, userId };
  return { ...depsCache, userId };
}

export interface IngestOutcome {
  reg: string;
  ok: boolean;
  animalId?: string;
  name?: string | null;
  created?: boolean;
  traitCount?: number;
  evaluation?: boolean;
  classification?: boolean;
  warnings?: string[];
  error?: string;
}

// Scrape + parse + import one registration number.
export async function ingestHolsteinReg(reg: string, userId?: string | null): Promise<IngestOutcome> {
  const R = reg.trim().toUpperCase();
  let scrape: ScrapeResult;
  try {
    scrape = await scrapeHolsteinAnimal(R);
  } catch (e) {
    return { reg: R, ok: false, error: `scrape failed: ${(e as Error)?.message ?? e}` };
  }
  if (scrape.error && (!scrape.mainText || !scrape.mainText.trim())) {
    return { reg: R, ok: false, name: scrape.name ?? null, error: scrape.error };
  }

  const deps = await resolveIngestDeps(userId);
  const capture = await prisma.sourceCapture.create({
    data: {
      sourceId: deps.holCanadaSourceId ?? undefined, captureType: "browser_lookup",
      sourceUrl: `https://www.holstein.ca/en/AIS/AIS?animalRegNo=${encodeURIComponent(R)}`,
      capturedById: userId ?? undefined, extractionStatus: "extracted", confidenceScore: 0.95,
      rawExtractedDataJson: JSON.stringify(scrape), notes: `Holstein.ca live scrape for ${R}`,
    },
  });

  try {
    const parsed = parseHolsteinExtract(scrape);
    const res = await importParsedHolstein(prisma, parsed, R, { ...deps, captureId: capture.captureId, animalIdParam: scrape.animalId ?? null });
    // Rich profile (owners, family tree, progeny) + authoritative classification history.
    const profile = parseHolsteinProfile(scrape);
    await storeHolsteinProfile(prisma, res.animalId, profile, { holCanadaSourceId: deps.holCanadaSourceId, userId: deps.userId });
    await recomputePreferredForAnimal(res.animalId);
    return {
      reg: R, ok: true, animalId: res.animalId, name: parsed.name ?? scrape.name ?? null,
      created: res.created, traitCount: res.traitCount, evaluation: res.evaluationWritten,
      classification: res.classificationWritten, warnings: res.warnings,
    };
  } catch (e) {
    return { reg: R, ok: false, name: scrape.name ?? null, error: `import failed: ${(e as Error)?.message ?? e}` };
  }
}
