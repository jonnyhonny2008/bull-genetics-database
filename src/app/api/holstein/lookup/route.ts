import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { ingestHolsteinReg } from "@/lib/holstein-ingest";
import { HOLSTEIN_REMOTE, closeHolsteinBrowser } from "@/lib/holstein-browser";

export const runtime = "nodejs";
export const maxDuration = 300; // a 6-tab scrape can take ~20-60s (esp. over a remote browser)

// On-demand single-animal lookup: scrape holstein.ca (real local browser),
// parse, and import. Body: { reg: "HOCANF..." }.
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
  if (!/^HOCAN[FM]?\d/i.test(reg) && !/^HO\d/i.test(reg)) {
    return NextResponse.json({ ok: false, error: "Enter a valid Holstein registration number (e.g. HOCANF121517751)." }, { status: 400 });
  }

  try {
    const outcome = await ingestHolsteinReg(reg, user?.uid);
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
  } finally {
    // On serverless (remote browser) end the session after each request so it
    // isn't billed idle; keep the local Chrome warm for fast reuse in dev.
    if (HOLSTEIN_REMOTE) await closeHolsteinBrowser();
  }
}
