import Link from "next/link";
import { prisma } from "@/lib/db";
import { cdcbRoundLabel } from "@/lib/us-cdcb/file-kind";
import type { GeneticSystem } from "@/lib/genetic-system";

// ---------------------------------------------------------------------------
// "This same bull is also evaluated on the other side."
//
// Both systems key off the SAME Animal.id — the American side is a parallel
// EVALUATION table, not a parallel animal roster — so /animals/<id> and
// /us/animals/<id> are the same bull seen through two different evaluations.
// The CA|US toggle in the header already carries the id across (see
// src/lib/genetic-system.ts). This banner exists so that fact is DISCOVERABLE:
// without it you have to already know the toggle preserves the bull.
//
// ===========================================================================
// THIS COMPONENT REPORTS EXISTENCE, COUNTS AND A ROUND LABEL. IT MUST NEVER
// RENDER A TRAIT VALUE FROM THE OTHER SYSTEM. Do not "improve" it by adding
// the other side's LPI, GTPI, NM$, Pro$ or any yield figure.
//
// A Lactanet EBV is in KILOGRAMS and a CDCB PTA is in POUNDS — roughly half the
// number for the same genetic merit. Putting an LPI next to a GTPI, or a kg
// figure beside a lb figure, is precisely the mistake the two-table
// architecture (GeneticEvaluation vs UsEvaluation) exists to make impossible,
// and it would be the worst bug this product can have: people buy semen off
// these pages. A banner that says "6 rounds, newest April 2026" cannot be
// misread as a merit comparison. A banner that shows one number can.
//
// The queries below therefore select ONLY round identity fields. Nothing that
// carries a unit is fetched at all, so there is nothing here to leak.
// ===========================================================================
// ---------------------------------------------------------------------------

interface Props {
  animalId: string;
  /** The system whose card is being rendered. The banner describes the OTHER one. */
  system: GeneticSystem;
  className?: string;
}

export default async function CrossSystemBanner({ animalId, system, className }: Props) {
  const other: GeneticSystem = system === "us" ? "ca" : "us";
  const side = other === "ca" ? await canadianSide(animalId) : await americanSide(animalId);

  // americanSide() returns null when the US tables have not been created yet.
  // That is a setup state of a half-built side of the app, not something to
  // explain on a live Canadian sire card — render nothing at all.
  if (!side) return null;

  const href = other === "us" ? `/us/animals/${animalId}` : `/animals/${animalId}`;
  const cardLabel = other === "us" ? "American card" : "Canadian card";

  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-xs ${
        side.rounds > 0 ? "border-brand-200 bg-brand-50" : "border-slate-200 bg-slate-50"
      } ${className ?? ""}`}
    >
      <span
        className={`rounded px-1.5 py-0.5 font-semibold tracking-wide ${
          side.rounds > 0 ? "bg-brand-600 text-white" : "bg-slate-300 text-slate-700"
        }`}
        title={other === "us" ? "American side — CDCB evaluations" : "Canadian side — Lactanet evaluations"}
      >
        {other.toUpperCase()}
      </span>

      <span className="text-slate-700">
        {side.headline}
        {side.detail && <span className="text-slate-500"> {side.detail}</span>}
      </span>

      {side.rounds > 0 || side.linkAnyway ? (
        <Link href={href} className="btn-secondary btn-sm ml-auto whitespace-nowrap" title={`The same bull on the ${cardLabel}`}>
          Open the {cardLabel} ›
        </Link>
      ) : null}

      {/* Said out loud on the page, not just in this comment: the two sides are
          navigable but their numbers are not interchangeable. */}
      <span className="w-full text-[11px] leading-tight text-slate-400">
        Same bull, same record — two separate evaluations. No value is carried across: Lactanet publishes
        breeding values in kilograms and CDCB publishes PTAs in pounds, so the two sets of numbers are read
        on their own pages only. The CA / US toggle in the header goes to the same place.
      </span>
    </div>
  );
}

// --- What the other side has -----------------------------------------------

interface OtherSide {
  /** Distinct rounds on file. Zero means the other side has nothing to show. */
  rounds: number;
  headline: string;
  detail?: string;
  /** True when there is a reason to visit even with no round (US provisional rows). */
  linkAnyway?: boolean;
}

/**
 * Canada, seen from the American card.
 *
 * Lactanet ships an OFFICIAL and an INTERIM file per run and both carry the same
 * `proofRun` label, so rows are counted per ROUND, not per row — otherwise a bull
 * with both files for April would be reported as two rounds.
 */
async function canadianSide(animalId: string): Promise<OtherSide> {
  const rows = await prisma.geneticEvaluation.findMany({
    where: { animalId, approvalStatus: "approved" },
    orderBy: { evaluationDate: "desc" },
    // Round identity only. No trait column is selected here, deliberately.
    select: { proofRun: true, evaluationDate: true },
  });

  const seen = new Set<string>();
  let newest: string | null = null;
  for (const r of rows) {
    const key = r.proofRun ?? monthKey(r.evaluationDate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!newest) newest = r.proofRun ?? monthLabel(r.evaluationDate);
  }

  if (seen.size === 0) {
    return { rounds: 0, headline: "No Lactanet evaluation on file for this bull." };
  }
  return {
    rounds: seen.size,
    headline: `Also evaluated in Canada — ${seen.size} Lactanet round${seen.size === 1 ? "" : "s"}${newest ? `, newest ${newest}` : ""}.`,
  };
}

/**
 * America, seen from the Canadian card.
 *
 * Only official triannual rounds count as rounds. CDCB's monthly and weekly adds
 * are provisional and are superseded at the next round, so they are named but
 * never counted as one — the same rule the American card itself applies.
 *
 * Uniqueness on UsEvaluation is (animalId, periodKey, sourceFamily), so ONE
 * official round can produce two rows for the same bull (the `all_evaluated` and
 * `young_pub` extracts are slices of a single evaluation). Rounds are therefore
 * counted per distinct roundCode.
 *
 * Returns null when the US tables do not exist yet.
 */
async function americanSide(animalId: string): Promise<OtherSide | null> {
  try {
    const [rows, betweenRoundRows] = await Promise.all([
      prisma.usEvaluation.findMany({
        where: { animalId, runKind: "official", approvalStatus: "approved" },
        orderBy: { evaluationDate: "desc" },
        // Round identity only. No trait column is selected here, deliberately.
        select: { roundCode: true, periodKey: true, evaluationDate: true },
      }),
      prisma.usEvaluation.count({ where: { animalId, runKind: { not: "official" } } }),
    ]);

    const seen = new Set<string>();
    let newest: string | null = null;
    for (const r of rows) {
      const key = r.roundCode ?? r.periodKey;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!newest) newest = usRoundLabel(r.roundCode) ?? monthLabel(r.evaluationDate);
    }

    if (seen.size === 0) {
      if (betweenRoundRows > 0) {
        return {
          rounds: 0,
          linkAnyway: true,
          headline: "No official CDCB round on file for this bull yet.",
          detail: `He does carry ${betweenRoundRows} provisional between-round row${betweenRoundRows === 1 ? "" : "s"}, which CDCB supersedes at the next round.`,
        };
      }
      return { rounds: 0, headline: "No CDCB evaluation on file for this bull." };
    }

    return {
      rounds: seen.size,
      headline: `Also evaluated in America — ${seen.size} CDCB round${seen.size === 1 ? "" : "s"}${newest ? `, newest ${newest}` : ""}.`,
    };
  } catch (e) {
    // The US tables are created by `prisma db push`. Until that has run, the
    // Canadian card must be completely unaffected by the American side existing.
    if (/does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message))) return null;
    throw e;
  }
}

// --- Round labels -----------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "April 2026" from an evaluation date — the fallback when no round label was stored. */
function monthLabel(d: Date | null): string | null {
  if (!d) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Grouping key for a round with no stored label. */
function monthKey(d: Date | null): string {
  return d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : "unknown";
}

/** cdcbRoundLabel wants a classified file; a round code (YYMM) is all we store. */
function usRoundLabel(roundCode: string | null): string | null {
  if (!roundCode) return null;
  return cdcbRoundLabel({ family: null, kind: null, breed: null, roundCode, periodKey: null, date: roundCode });
}
