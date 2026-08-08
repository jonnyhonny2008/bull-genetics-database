import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getCaProofCardData } from "@/lib/proof-card-ca";
import { CaProofCardPdf } from "@/lib/proof-card-pdf-ca";
import { buildCaProofCardWorkbook, caProofCardFilename } from "@/lib/proof-card-xlsx";
import { attachment } from "@/lib/report-http";

// Same read gate the Canadian animal profile page itself is reachable behind:
// the /animals nav item (and the American sire card's own explicit check,
// src/app/(app)/us/animals/[id]/page.tsx) both require "animal:read", not
// "compare:read" — confirmed by reading both pages rather than assumed.
export const dynamic = "force-dynamic";
// A single animal's proof card — one Prisma read plus one PDF/XLSX render, no
// live external lookups. 30s matches this phase's own spec and is generous
// for that workload.
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const format = sp.format === "xlsx" ? "xlsx" : "pdf";
  const locale = sp.locale === "fr" ? "fr" : "en";

  const data = await getCaProofCardData(params.id);
  if (!data) {
    return NextResponse.json(
      { error: "No approved proof on file for this animal — a Proof Card needs at least one approved genetic evaluation." },
      { status: 404 },
    );
  }

  if (format === "xlsx") {
    const wb = await buildCaProofCardWorkbook(data);
    const buf = await wb.xlsx.writeBuffer();
    return new Response(buf, {
      headers: attachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", caProofCardFilename(data)),
    });
  }

  const buf = await renderToBuffer(CaProofCardPdf({ data, locale }));
  const filename = `${data.name} - Proof Card - ${locale.toUpperCase()}.pdf`.replace(/[\\/:*?"<>|]/g, "-");
  return new Response(buf, { headers: attachment("application/pdf", filename) });
}
