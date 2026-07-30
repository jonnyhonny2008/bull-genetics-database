import "server-only";

// ---------------------------------------------------------------------------
// Server-only surface for Holstein.ca parsing. The actual logic lives in
// ./holstein-parse (a PURE module with no server-only guard) so that the tsx
// bulk importer (prisma/import-holstein.ts) and unit tests can reuse it. This
// file just re-exports it for `@/lib/holstein` importers (server components /
// actions), preserving the original import path.
//
// Compliance note (unchanged): we do NOT auto-fetch Holstein.ca from the
// server — their WAF returns 403 to non-browser clients. Fetching happens in
// the user's own browser via scripts/holstein-extract.js (same-origin fetch of
// pages that are publicly viewable); this code only interprets the result.
// ---------------------------------------------------------------------------

export * from "./holstein-parse";
