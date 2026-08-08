import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { getUsProofCardData } from "@/lib/proof-card-us";
import { UsProofCardPdf } from "@/lib/proof-card-pdf-us";
import { buildUsProofCardWorkbook, usProofCardFilename } from "@/lib/proof-card-xlsx";
import { attachment } from "@/lib/report-http";

// Sibling of ../../../animals/[id]/proof-card/route.ts — same "animal:read"
// gate the American sire card page itself requires (src/app/(app)/us/animals/
// [id]/page.tsx's own explicit `if (!can(user?.role, "animal:read"))` check).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = currentUser();
  if (!can(user?.role, "animal:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = Object.fromEntries(new URL(request.url).searchParams) as Record<string, string>;
  const format = sp.format === "xlsx" ? "xlsx" : "pdf";
  const locale = sp.locale === "fr" ? "fr" : "en";

  const data = await getUsProofCardData(params.id);
  if (!data) {
    return NextResponse.json(
      { error: "No official, approved CDCB round on file for this animal — a Proof Card needs at least one." },
      { status: 404 },
    );
  }

  if (format === "xlsx") {
    const wb = await buildUsProofCardWorkbook(data);
    const buf = await wb.xlsx.writeBuffer();
    return new Response(buf, {
      headers: attachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", usProofCardFilename(data)),
    });
  }

  const buf = await renderToBuffer(UsProofCardPdf({ data, locale }));
  const filename = `${data.name} - Proof Card - American - ${locale.toUpperCase()}.pdf`.replace(/[\\/:*?"<>|]/g, "-");
  return new Response(buf, { headers: attachment("application/pdf", filename) });
}
