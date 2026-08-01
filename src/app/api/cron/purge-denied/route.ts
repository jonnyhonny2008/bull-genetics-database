import { NextResponse } from "next/server";
import { purgeDeniedImports } from "@/lib/import-staging";
import { logAppError } from "@/lib/error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Daily purge of denied imports past the 30-day window (see vercel.json crons).
// Auth: Vercel sets the x-vercel-cron header on real cron invocations (it strips
// that header from external requests); a manual/testing call must present
// CRON_SECRET as a Bearer token.
export async function GET(request: Request) {
  // Require the CRON_SECRET bearer whenever it is configured (Vercel auto-sends it
  // on cron invocations). Only when NO secret is set do we fall back to trusting
  // the Vercel-internal x-vercel-cron header — so a configured secret can't be
  // sidestepped by a spoofed header.
  const secret = process.env.CRON_SECRET;
  const bearerOk = !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
  const vercelCronOk = !secret && !!request.headers.get("x-vercel-cron");
  if (!bearerOk && !vercelCronOk) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await purgeDeniedImports(new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    await logAppError("cron/purge-denied", e);
    return NextResponse.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
}
