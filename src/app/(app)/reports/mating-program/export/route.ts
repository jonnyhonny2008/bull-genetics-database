import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getMatingProgramReport } from "@/lib/mating-program";
import { buildMatingProgramWorkbook, matingProgramFilename } from "@/lib/mating-program-xlsx";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  // The workbook's Excluded sheet IS the audit trail, so it takes the complete
  // exclusion list. The web page caps that list because its copy is serialised
  // into the browser payload on every load; this one never leaves the server.
  const report = await getMatingProgramReport(sp, { fullExclusions: true });
  const wb = await buildMatingProgramWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  const filename = matingProgramFilename(report);

  return new Response(buf, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // filename* (RFC 5987) keeps the spaces/em-dashes intact in modern browsers.
      "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "-")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
    },
  });
}
