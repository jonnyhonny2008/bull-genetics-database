// Shared response headers for the report export routes, so the RFC 5987
// content-disposition dance lives in exactly one place. A filename may contain
// spaces and em-dashes (e.g. "Mating Program — 12 females - LPI.xlsx"); the
// ASCII `filename=` gets those stripped to hyphens as a fallback, and
// `filename*=UTF-8''…` carries the real name for browsers that honour it.

export function attachment(contentType: string, filename: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "-")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "cache-control": "no-store",
  };
}
