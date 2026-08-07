// ---------------------------------------------------------------------------
// The words every exported American report has to carry.
//
// An export leaves the app. The screen versions of these reports can rely on the
// page around them — the units are in the subtitle, the intermediate-optimum
// warning is in a column tooltip, the GTPI provenance is in a footer the reader
// scrolled past. A workbook or a self-contained HTML file arrives as an email
// attachment months later with none of that, and is read by someone who never
// saw the app. So the disclosures travel INSIDE the file.
//
// Four of them are not house style, they are correctness:
//
//   * POUNDS. A CDCB PTA is roughly half the Canadian EBV for the same bull. A
//     recipient who has also been sent a Lactanet report will put the two side by
//     side; the file has to say which one it is.
//   * GTPI IS OURS. CDCB does not publish it. We compute it from the Holstein
//     Association USA formula in force for the round (index-registry.ts) and it
//     lands within about ±3 points, so it is reported whole. Presenting it as an
//     official figure would be a false attribution.
//   * TPI IS A TRADEMARK of Holstein Association USA, and that has to be
//     acknowledged wherever the mark appears — including in a file we do not
//     control once it is sent.
//   * RUMP ANGLE HAS AN INTERMEDIATE OPTIMUM. Its movement is shown but never
//     called an improvement or a decline, and never ranked. A reader who assumes
//     "green is good" for every other column has to be told this one is different.
//
// They are plain strings so the Excel builders can write them into a cell and the
// HTML builders can escape them into a notice — one wording, two destinations.
// ---------------------------------------------------------------------------

import { noticeHtml, esc } from "../report-html";

/** GTPI is computed by this app, not published by CDCB. */
export const US_GTPI_NOTE =
  "GTPI is calculated by Blondin Sires from CDCB evaluations using the Holstein Association USA formula in force " +
  "for each round. It is not an official Holstein Association USA publication and is typically within ±3 points of " +
  "the published figure, so it is reported as a whole number and its change is a whole number too.";

/** Required wherever the mark appears — this file travels outside the app. */
export const US_TPI_TRADEMARK = "TPI is a registered trademark of Holstein Association USA.";

/** The units line. The one sentence in this file most likely to prevent a real error. */
export const US_POUNDS_NOTE =
  "All yield values are CDCB PTAs in POUNDS (Milk, Fat, Protein), and the merit indexes are US dollars. " +
  "These are not Canadian EBVs in kilograms — an American PTA is roughly half the Canadian figure for the same " +
  "bull, so the two must never be compared or combined.";

/** Rump angle is shown, never judged. */
export const US_RPA_NOTE =
  "Rump Angle has an intermediate optimum: neither the highest nor the lowest value is best. Its change is shown " +
  "because the size of a move is informative, but it is never coloured as favourable or unfavourable, never " +
  "ranked, and never sorted on.";

/** Only the triannual files are rounds. */
export const US_OFFICIAL_ROUNDS_NOTE =
  "Only official triannual CDCB rounds (April, August and December) are compared. Monthly and weekly CDCB adds " +
  "carry provisional values for animals that had none before, and are never read as a round.";

/** GTPI exists for Holstein only, so any GTPI-led digest is a Holstein digest. */
export const US_GTPI_HOLSTEIN_ONLY =
  "GTPI is computed for Holstein only, so any section led by GTPI covers Holstein bulls whatever else the round " +
  "contains.";

/** Graduating bulls are shown but held out of every statistic. */
export const US_GRADUATION_NOTE =
  "A bull receiving his first daughter-based evaluation moves several times further than an ordinary bull. That " +
  "is expected rather than surprising, so graduates are held out of every mean and standard deviation and are " +
  "never flagged as unusual movers. Their figures are still shown.";

/**
 * The callouts that sit at the top of an exported HTML report, above the tables —
 * where a reader meets them before reading a single number.
 *
 * `noticeHtml` takes already-built markup, so the literal <strong> tags below are
 * ours and the prose goes through esc() even though it is also ours: the constants
 * are the kind of thing that grows an ampersand one day.
 */
export function usExportNotices(): string[] {
  return [
    noticeHtml(`<strong>US units — pounds.</strong> ${esc(US_POUNDS_NOTE)}`, "danger"),
    noticeHtml(`<strong>GTPI is calculated, not published.</strong> ${esc(US_GTPI_NOTE)} ${esc(US_TPI_TRADEMARK)}`, "warn"),
    noticeHtml(`<strong>Rump Angle is never judged.</strong> ${esc(US_RPA_NOTE)}`, "info"),
  ];
}

/**
 * The caveat list for the foot of an exported HTML report.
 *
 * `extra` goes first because it is the report's own — how its cohort was drawn,
 * what its cap was — and the standing American disclosures follow.
 */
export function usExportFootnotes(extra: string[] = []): string[] {
  return [
    ...extra,
    US_POUNDS_NOTE,
    US_GTPI_NOTE,
    US_TPI_TRADEMARK,
    US_RPA_NOTE,
    US_OFFICIAL_ROUNDS_NOTE,
  ];
}

/**
 * The same disclosures as label/value pairs, for the "Read me" sheet an exported
 * workbook opens on. Excel has no callout, so the notes get a sheet of their own
 * rather than being crammed into a header row nobody widens.
 */
export function usWorkbookNotes(): { label: string; text: string }[] {
  return [
    { label: "Units", text: US_POUNDS_NOTE },
    { label: "GTPI", text: US_GTPI_NOTE },
    { label: "Trademark", text: US_TPI_TRADEMARK },
    { label: "Rump Angle", text: US_RPA_NOTE },
    { label: "Rounds", text: US_OFFICIAL_ROUNDS_NOTE },
    { label: "Graduations", text: US_GRADUATION_NOTE },
  ];
}

/** Strip what a filesystem or a Content-Disposition header would choke on. */
export function safeFilePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "-");
}
