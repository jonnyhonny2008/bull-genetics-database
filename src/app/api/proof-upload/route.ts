import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { importsDir } from "@/lib/lactanet";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

// Streams an uploaded proof CSV to the imports/ folder (no server-action size limit).
export async function POST(request: Request) {
  const user = getSessionUser();
  if (!can(user?.role, "record:write")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0) {
    return NextResponse.redirect(new URL("/import-proofs?err=nofile", request.url));
  }
  // Cap upload size so a hostile/oversized file can't exhaust memory or disk.
  const MAX_BYTES = 80 * 1024 * 1024; // 80 MB (real proof exports run ~30 MB)
  if (file.size > MAX_BYTES) {
    return NextResponse.redirect(new URL("/import-proofs?err=toolarge", request.url));
  }

  const dir = importsDir();
  await mkdir(dir, { recursive: true });
  // Strip every path part + unsafe char; the result is a bare CSV basename.
  const base = path.basename(file.name || "upload.csv").replace(/[^a-zA-Z0-9._-]/g, "_");
  const finalName = base.toLowerCase().endsWith(".csv") ? base : `${base}.csv`;
  await writeFile(path.join(dir, finalName), Buffer.from(await file.arrayBuffer()));

  return NextResponse.redirect(new URL(`/import-proofs?uploaded=${encodeURIComponent(finalName)}`, request.url), 303);
}

export const runtime = "nodejs";
