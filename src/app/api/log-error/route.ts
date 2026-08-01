import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { logAppError } from "@/lib/error-log";

export const runtime = "nodejs";

// Client error boundaries POST here so browser-side/render errors land in the
// same audit-backed error log as server errors. Best-effort; always returns ok.
export async function POST(request: Request) {
  let body: { source?: string; message?: string; stack?: string; digest?: string; url?: string } = {};
  try { body = await request.json(); } catch { /* ignore malformed */ }
  const user = getSessionUser();
  await logAppError(
    String(body.source ?? "client").slice(0, 200),
    { message: body.message, stack: body.stack, digest: body.digest },
    { origin: "client", url: String(body.url ?? "").slice(0, 300), userId: user?.uid ?? null, userName: user?.name ?? null },
  );
  return NextResponse.json({ ok: true });
}
