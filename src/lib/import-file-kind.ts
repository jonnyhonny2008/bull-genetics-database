// ---------------------------------------------------------------------------
// Which GENETIC SYSTEM a bull-proof export file belongs to — Canadian Lactanet
// or American CDCB — so an importer built for one never silently mis-parses the
// other.
//
// Two importers exist (prisma/import-all-bulls.ts for Lactanet CSVs,
// prisma/import-cdcb.ts for CDCB infoANIM/infoEVAL pairs) and their column
// shapes share nothing — a CDCB file fed to the Lactanet parser would not error,
// it would just read every field as garbage (wrong delimiter, wrong columns),
// which is worse than refusing outright. This module is the guard.
//
// TWO INDEPENDENT SIGNALS, checked in order of reliability:
//
//   1. CONTENT (when the caller has a first line to hand) is definitive and
//      format-native, so it wins whenever available:
//        Lactanet — a comma CSV header starting "REGISTRATION NUMBER,..."
//        CDCB     — a pipe-delimited preamble "#TYPE:ANIM|RUN:...|DATE:...."
//                   (often preceded by a UTF-8 BOM — CDCB ships these that way).
//
//   2. FILENAME is the fallback (or fast pre-check) when no content is at hand:
//        CDCB     — starts with a bare 2-letter breed code + underscore
//                   (HO_/JE_/BS_/GU_/AY_...) — see src/lib/us-cdcb/file-kind.ts.
//        Lactanet — the gealltraits_* families, a bare stud+GERUN name, or the
//                   whole-breed archive naming (aiobgepa*) — see
//                   src/lib/proof-file-kind.ts. None of these start with a bare
//                   breed-code prefix, which is what keeps the two disjoint.
//
// Pure (no prisma, no "server-only") so both bulk importers and any future
// upload-route guard can use it identically.
// ---------------------------------------------------------------------------

import { classifyCdcbFile } from "./us-cdcb/file-kind";

export type ImportSystem = "lactanet" | "cdcb" | "unknown";

const CDCB_PREAMBLE_RE = /^#TYPE:/;
const LACTANET_HEADER_RE = /^REGISTRATION NUMBER,/i;

/** Strip a leading UTF-8 BOM, which CDCB's own export tool writes. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function isCdcbShapedName(fileName: string): boolean {
  return classifyCdcbFile(fileName).breed !== null;
}

/** Lactanet file-name families — see proof-file-kind.ts for the authoritative
 *  classifier. Duplicated narrowly here (name-shape only, no official/interim
 *  detail) so this module stays a standalone, dependency-free differentiator. */
function isLactanetShapedName(fileName: string): boolean {
  const name = (fileName ?? "").trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (/gealltraits|aiobgepa|pregeno/.test(lower)) return true;
  // A bare stud+GERUN name, e.g. "07992604_ho.csv" — 6 consecutive digits ending
  // in a valid month. Excluded if it also reads as a CDCB breed-prefixed name
  // (defence only; the two shapes cannot both match a real file in practice).
  return /\d{4}\d{2}(?:0[1-9]|1[0-2])/.test(lower) && !/^[a-z]{2}_/.test(lower);
}

/**
 * Decide which genetic system a file belongs to.
 *
 * Pass `firstLine` whenever you have it (the importers already read the file's
 * first line to build the column index, so it is free) — content beats name,
 * because a hash-prefixed or renamed file keeps its shape even when its name
 * does not. Falls back to the filename alone when no content is available yet.
 */
export function detectImportSystem(fileName: string, firstLine?: string | null): ImportSystem {
  if (firstLine != null) {
    const line = stripBom(firstLine).trim();
    if (CDCB_PREAMBLE_RE.test(line)) return "cdcb";
    if (LACTANET_HEADER_RE.test(line)) return "lactanet";
  }
  const cdcbName = isCdcbShapedName(fileName);
  const lactanetName = isLactanetShapedName(fileName);
  if (cdcbName && !lactanetName) return "cdcb";
  if (lactanetName && !cdcbName) return "lactanet";
  return "unknown";
}

/** Human label, for error messages and any future UI. */
export function importSystemLabel(system: ImportSystem): string {
  return system === "cdcb" ? "CDCB (American)" : system === "lactanet" ? "Lactanet (Canadian)" : "an unrecognised";
}
