import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  resolveParentForPA, computeParentAverage, loadPAAliasCorpus,
  type PAParent, type PAResult, type PAAncestor,
} from "@/lib/parent-average";
import { ingestLactanetReg } from "@/lib/lactanet-ingest";
import type { LinearGroup } from "@/components/LinearGraph";

export const runtime = "nodejs";
export const maxDuration = 180; // up to a dam + 5 live Lactanet lookups

export interface PAMating {
  sire: PAResult["sire"];
  result: PAResult;
  linearGroups: LinearGroup[];
  sireAncestors: PAAncestor[]; // for the calf pedigree
  damAncestors: PAAncestor[];
}
export interface PAResponse {
  ok: boolean;
  error?: string;
  dam: PAResult["dam"] | null;
  matings: PAMating[];
}

/** Build the linear-chart groups for a set of PA values, using the trait defs. */
async function linearGroupsFor(paByCode: Map<string, number>): Promise<LinearGroup[]> {
  if (!paByCode.size) return [];
  const defs = await prisma.traitDefinition.findMany({ where: { domain: "genetic", isLinear: true } });
  const byGroup = new Map<string, { order: number; datum: LinearGroup["traits"][number] }[]>();
  for (const d of defs) {
    const v = paByCode.get(d.traitCode);
    if (v == null) continue;
    const g = d.graphGroup ?? "Linear";
    const arr = byGroup.get(g) ?? [];
    arr.push({
      order: d.displayOrder,
      datum: { name: d.traitName, value: v, min: d.graphMin ?? -15, max: d.graphMax ?? 15, left: d.leftLabel ?? "", right: d.rightLabel ?? "", descriptor: null },
    });
    byGroup.set(g, arr);
  }
  return [...byGroup.entries()].map(([group, arr]) => ({
    group,
    traits: arr.sort((a, b) => a.order - b.order).map((x) => x.datum),
  }));
}

export async function POST(request: Request) {
  const user = getSessionUser();
  if (!can(user?.role, "compare:read")) {
    return NextResponse.json({ ok: false, error: "Not authorized." }, { status: 403 });
  }

  let body: { damReg?: string; sireRegs?: unknown; save?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Send JSON." }, { status: 400 }); }

  // --- SAVE MODE: import the ticked animals (requires write permission) ---
  if (Array.isArray(body.save) && body.save.length) {
    if (!can(user?.role, "record:write")) {
      return NextResponse.json({ ok: false, error: "You don't have permission to import animals." }, { status: 403 });
    }
    const regs = [...new Set(body.save.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    const saved: { reg: string; ok: boolean; name?: string | null; error?: string; evaluationSaved?: boolean; warnings?: string[] }[] = [];
    for (const reg of regs) {
      const out = await ingestLactanetReg(reg, user?.uid);
      // Surface a partial save (identity stored but the proof itself didn't) rather
      // than reporting a clean success and discarding the warnings.
      saved.push({ reg, ok: out.ok, name: out.name, error: out.error, evaluationSaved: out.evaluationSaved, warnings: out.warnings });
    }
    return NextResponse.json({ ok: saved.every((s) => s.ok), saved });
  }

  // --- COMPUTE MODE ---
  const damReg = String(body.damReg ?? "").trim();
  const sireRegs = Array.isArray(body.sireRegs)
    ? [...new Set((body.sireRegs as unknown[]).map((s) => String(s).trim()).filter(Boolean))].slice(0, 5)
    : [];
  if (!damReg || !sireRegs.length) {
    return NextResponse.json({ ok: false, error: "Provide a dam registration number and 1–5 sire registration numbers.", dam: null, matings: [] }, { status: 400 });
  }

  // Resolve the dam once; resolve each sire; both may be live Lactanet lookups.
  const dam = await resolveParentForPA(damReg);
  const sires = await Promise.all(sireRegs.map((r) => resolveParentForPA(r)));

  // One small identifier query, so the relatedness screen recognises an animal
  // held under both a Canadian registration and a NAAB code as one animal.
  const corpus = await loadPAAliasCorpus();

  const matings: PAMating[] = [];
  for (const sire of sires) {
    const result = computeParentAverage(sire, dam, corpus);
    const paByCode = new Map<string, number>(result.pa.map((r) => [r.code, r.pa]));
    matings.push({
      sire: result.sire,
      result,
      linearGroups: sireRegs.length === 1 ? await linearGroupsFor(paByCode) : [],
      sireAncestors: sire.ancestors,
      damAncestors: dam.ancestors,
    });
  }

  const resp: PAResponse = { ok: dam.found, dam: matings[0]?.result.dam ?? null, matings };
  if (!dam.found) resp.error = dam.error ?? `Dam ${dam.reg} not found.`;
  return NextResponse.json(resp);
}
