import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { ingestLactanetReg } from "@/lib/lactanet-ingest";
import { parseReg } from "@/lib/lactanet-web";

export const runtime = "nodejs";
export const maxDuration = 120; // 8 plain GETs — seconds, not minutes

// On-demand single-animal lookup against Lactanet Genetics. Body: { reg }.
// No browser required, so this works on serverless the same as locally.
export async function POST(request: Request) {
  const user = getSessionUser();
  if (!can(user?.role, "record:write")) {
    return NextResponse.json({ ok: false, error: "Not authorized." }, { status: 403 });
  }

  let reg = "";
  try {
    const body = await request.json();
    reg = String(body?.reg ?? "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Send JSON { reg }." }, { status: 400 });
  }
  if (!parseReg(reg)) {
    return NextResponse.json(
      { ok: false, error: "Enter a full registration number, e.g. HOCANM13486161 or HOCANF14269881." },
      { status: 400 },
    );
  }

  const outcome = await ingestLactanetReg(reg, user?.uid);
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
}
