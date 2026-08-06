import "server-only";

import { prisma } from "./db";
import { recomputePreferredForAnimal } from "./priority";
import { packTraits } from "./eval-traits";
import { classifyProofFile, parseReleaseDate, type ProofRunKind } from "./proof-file-kind";
import { classifyRound, isGenotyped } from "./sire-class";
import type { ParsedBull } from "./lactanet";

// Persistence for one parsed Lactanet bull-proof row. Extracted from the
// import-proofs server actions so it can also be reused by the browser-chunked
// mass-import API route (/api/proof-import/chunk) — the same upsert either way.

export function proofRunLabel(gerun: string | null): { label: string; date: Date } {
  // GERUN is YYMM (e.g. "2604" = April 2026).
  const m = (gerun ?? "").match(/^(\d{2})(\d{2})$/);
  const now = new Date();
  if (!m) return { label: "Imported proof", date: now };
  const yy = parseInt(m[1]);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  const month = Math.min(12, Math.max(1, parseInt(m[2])));
  const monthName = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month];
  return { label: `${monthName} ${year}`, date: new Date(Date.UTC(year, month - 1, 1)) };
}

// Module-level breed cache so bulk imports don't hit the DB once per row.
const _breedCache = new Map<string, string | null>();
async function getBreedId(breedCode: string): Promise<string | null> {
  if (_breedCache.has(breedCode)) return _breedCache.get(breedCode) ?? null;
  const b = await prisma.breed.findUnique({ where: { breedCode }, select: { breedId: true } });
  _breedCache.set(breedCode, b?.breedId ?? null);
  return b?.breedId ?? null;
}

// Persist one parsed bull: upsert animal + identifiers + roles + a dated genetic
// evaluation with all trait values + a pedigree reference. Returns the animal id.
export async function persistBull(
  bull: ParsedBull,
  ctx: { sourceId: string | null; captureId: string | null; userId?: string; fileName: string; approvalStatus?: "approved" | "pending" },
): Promise<{ animalId: string; created: boolean; evaluationId: string }> {
  const breedId = await getBreedId(bull.breedCode);
  const approvalStatus = ctx.approvalStatus ?? "approved";
  const isApproved = approvalStatus === "approved";

  // Identity is the REGISTRATION number, which is permanent. NAAB / semen codes are
  // recycled and reassigned between bulls over time, so matching on the NAAB can
  // graft a brand-new bull's proof onto whichever animal last held that code — and
  // then overwrite its name (see the name-adoption block below). A wrong number on
  // the wrong bull is the worst failure this app can have, so identity is resolved
  // by registration ONLY. The NAAB is still recorded as an identifier below; it is
  // just never used to decide WHO this row belongs to. This brings the Vercel-native
  // path in line with the local importer (prisma/import-cdn.ts), which already keys
  // on registration idTypes only.
  const REG_ID_TYPES = Array.from(new Set([bull.regIdType, "registration_ca", "registration_us", "registration_int"]));
  const regMatch = await prisma.animalIdentifier.findFirst({
    where: { idValue: bull.registrationNumber, idType: { in: REG_ID_TYPES } },
    select: { animalId: true },
  });
  let animalId = regMatch?.animalId ?? null;
  let wasCreated = false;

  const { label: runLabel, date: runDate } = proofRunLabel(bull.proofRun);

  if (!animalId) {
    wasCreated = true;
    const created = await prisma.animal.create({
      data: {
        primaryName: bull.registeredName,
        shortName: bull.shortName,
        sex: "M",
        breedId: breedId ?? null,
        birthDate: bull.birthDate ? new Date(bull.birthDate + "T00:00:00Z") : null,
        countryOfOrigin: bull.country,
        currentStatus: "proven",
        createdById: ctx.userId,
        notes: `Imported from Lactanet proof file (${ctx.fileName}).`,
      },
    });
    animalId = created.id;
    // Identifiers
    await prisma.animalIdentifier.create({ data: { animalId, idType: bull.regIdType, idValue: bull.registrationNumber, issuingCountry: bull.country, sourceId: ctx.sourceId, isPrimary: true } });
    if (bull.naabCode) {
      // A NAAB code belongs to one active bull at a time. If this code was
      // previously assigned to a different animal, that assignment is now stale —
      // deactivate it so "active = carries a NAAB code" keeps pointing at the
      // current holder alone (see the sire-status rules) instead of two bulls.
      await prisma.animalIdentifier.updateMany({ where: { idType: "naab", idValue: bull.naabCode, active: true }, data: { active: false } });
      await prisma.animalIdentifier.create({ data: { animalId, idType: "naab", idValue: bull.naabCode, sourceId: ctx.sourceId, active: true } });
    }
    if (bull.naabMarketingCode) await prisma.animalIdentifier.create({ data: { animalId, idType: "marketing_code", idValue: bull.naabMarketingCode, sourceId: ctx.sourceId } });
    // Role
    await prisma.animalRole.create({ data: { animalId, roleType: "proven_bull", active: true } });
    await prisma.animalRole.create({ data: { animalId, roleType: "reference_sire", active: true } });
  }

  // Descriptive genomics as text trait values.
  const descriptive: { code: string; text: string | null }[] = [
    { code: "A2", text: bull.betaCasein },
    { code: "POLLED", text: bull.polled },
    { code: "COLOUR", text: bull.colourCode },
  ];

  // Which Lactanet extract is this? Official and interim runs share a GERUN, so
  // they share `runLabel` — the file name is the only thing that separates them.
  const fileId = classifyProofFile(ctx.fileName);
  const runKind: ProofRunKind | null = fileId.kind;
  // The weekly release date, when the file name carries one. Lactanet ships several
  // interim revisions of the same run; this makes "newest revision wins" the rule.
  const incomingRelease = parseReleaseDate(fileId.releaseDate);

  // Avoid duplicate evaluations for the same run + source — but NEVER disturb an
  // existing APPROVED evaluation when staging a pending import. A pending write
  // must be a brand-new row so that denying it can't destroy a pre-existing
  // approved proof. Approved writes replace the prior row for the run as before.
  //
  // `runKind` is part of the key: without it the interim April file overwrites
  // the official April proof (or the reverse, depending on upload order) and the
  // loss is silent, because both rows look identical apart from their values.
  // A null kind — an unrecognised file name — only ever replaces another null.
  const existingEval = await prisma.geneticEvaluation.findFirst({
    where: { animalId, proofRun: runLabel, sourceId: ctx.sourceId, runKind, ...(isApproved ? {} : { approvalStatus: "pending" }) },
  });
  if (existingEval) {
    // Keep the most recent weekly revision of a run. If a newer-dated file for this
    // same round is already stored, importing an older revision must NOT clobber it
    // with staler numbers — which one wins would otherwise depend on import order.
    if (incomingRelease && existingEval.releaseDate && existingEval.releaseDate > incomingRelease) {
      await recomputePreferredForAnimal(animalId);
      return { animalId, created: wasCreated, evaluationId: existingEval.evaluationId };
    }
    await prisma.geneticEvaluation.delete({ where: { evaluationId: existingEval.evaluationId } });
  }

  const lpiRel = bull.traits.find((t) => t.traitCode === "LPI")?.reliability ?? null;
  const packed = packTraits([
    ...bull.traits,
    ...descriptive.filter((d) => d.text).map((d) => ({ traitCode: d.code, numericValue: null, textValue: d.text!, reliability: null, percentileRank: null })),
  ]);
  const evalRec = await prisma.geneticEvaluation.create({
    data: {
      animalId, sourceId: ctx.sourceId, captureId: ctx.captureId, evaluationDate: runDate,
      // Per-bull breed, matching the breedId resolved above (and
      // prisma/import-cdn.ts) — a Jersey row must not record a Holstein context.
      proofRun: runLabel, countrySystem: "CA", breedContext: bull.breedCode,
      reliabilityOverall: lpiRel != null ? lpiRel / 100 : null,
      isPreferred: false,
      approvalStatus,
      approvedById: isApproved ? ctx.userId : undefined,
      approvedAt: isApproved ? new Date() : undefined,
      createdById: ctx.userId, notes: `Imported from ${ctx.fileName}.`,
      runKind, sourceFile: ctx.fileName, releaseDate: incomingRelease,
      // Lactanet status codes for this round. These were being dropped here while
      // prisma/import-cdn.ts recorded them, so a proof uploaded through the web
      // screen lost its daughter count and its proven/genomic classification.
      activityCode: bull.activityCode, officialCode: bull.officialCode,
      genotyped: isGenotyped(bull.activityCode), daughters: bull.daughters, herds: bull.herds,
      sireType: classifyRound(bull),
      traitsJson: packed.traitsJson, ...packed.columns,
    },
  });

  // Pedigree reference (immediate 3-gen summary from the proof).
  if (bull.pedigree.length) {
    const summary = bull.pedigree.map((p) => `${p.relation.toUpperCase()}: ${p.name ?? "?"}${p.reg ? ` (${p.reg})` : ""}`).join(" · ");
    await prisma.pedigreeReference.deleteMany({ where: { animalId, source: { sourceName: "LactanetGen" } } });
    await prisma.pedigreeReference.create({
      data: {
        animalId, sourceId: ctx.sourceId, displayStatus: "linked", lastCheckedAt: new Date(),
        notes: `Pedigree (from proof): ${summary}`,
      },
    });
  }

  // Registered names change over time (new prefix, registry correction). Keep the
  // animal's name from its NEWEST proof: if this approved round is the latest on
  // file, adopt this file's name. (New animals already took it at creation.)
  if (!wasCreated && isApproved && bull.registeredName) {
    const newer = await prisma.geneticEvaluation.findFirst({
      where: { animalId, approvalStatus: "approved", evaluationDate: { gt: runDate } },
      select: { evaluationId: true },
    });
    if (!newer) {
      await prisma.animal.update({ where: { id: animalId }, data: { primaryName: bull.registeredName, shortName: bull.shortName } });
    }
  }

  await recomputePreferredForAnimal(animalId);
  return { animalId, created: wasCreated, evaluationId: evalRec.evaluationId };
}
