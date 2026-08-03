import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getProofForecastReport } from "@/lib/proof-forecast";
import { buildProofForecastWorkbook, proofForecastFilename } from "@/lib/proof-forecast-xlsx";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = currentUser();
  if (!can(user?.role, "compare:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const report = await getProofForecastReport(sp);
  const wb = await buildProofForecastWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  const filename = proofForecastFilename(report);

  return new Response(buf, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // filename* (RFC 5987) keeps the spaces/em-dashes intact in modern browsers.
      "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "-")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
    },
  });
}
