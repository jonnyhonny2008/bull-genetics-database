// ---------------------------------------------------------------------------
// Formatting the agent's answer for display.
//
// The chat panel shows plain text, so we (1) pull out any ```chart blocks and
// parse them into specs the app renders with its own SVG components, (2) scrub
// stray markdown so answers read like a clean text message, and (3) split the
// trailing "Follow-ups:" suggestions into chips. Pure functions, unit-tested.
// ---------------------------------------------------------------------------

// A chart the agent can draw. It emits one as a ```chart JSON block; the app
// renders it with trusted SVG components — never by injecting model HTML.
export interface ChartSpec {
  type?: "line" | "bars";
  title?: string;
  yLabel?: string;
  valueSuffix?: string;
  series?: { label?: string; color?: string; dashed?: boolean; points: { x: string; y: number | null }[] }[];
  rows?: { label: string; a: number | null; b: number | null }[];
  aLabel?: string;
  bLabel?: string;
}

/** Pull ```chart …``` blocks out of an answer; drop malformed ones silently. */
export function extractCharts(text: string): { text: string; charts: ChartSpec[] } {
  const charts: ChartSpec[] = [];
  const stripped = text.replace(/```chart\s*([\s\S]*?)```/gi, (_m, json) => {
    try {
      const spec = JSON.parse(String(json).trim());
      if (spec && typeof spec === "object") charts.push(spec as ChartSpec);
    } catch { /* ignore a malformed chart block */ }
    return "";
  });
  return { text: stripped, charts };
}

/** Scrub markdown so the answer reads like a plain text message; bullets → "- ". */
export function cleanText(text: string): string {
  return text
    .replace(/```([\s\S]*?)```/g, "$1")            // code fences
    .replace(/`([^`]+)`/g, "$1")                    // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")             // # headings
    .replace(/^\s*>\s?/gm, "")                      // > blockquotes
    .replace(/^(\s*)[*•]\s+/gm, "$1- ")             // *, • bullets -> "- "
    .replace(/^(\s*)[-–—]\s+/gm, "$1- ")            // normalise dashes -> "- "
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1")      // *italic* **bold** ***both***
    .replace(/\*{2,}/g, "")                         // any orphan ** runs
    .replace(/__([^_\n]+)__/g, "$1")                // __bold__
    .replace(/^\s*\|?[-\s|:]+\|?\s*$/gm, "")        // table separator rows
    .replace(/\s*\|\s*/g, "  ")                     // table pipes -> spaces
    .replace(/[ \t]{2,}/g, " ")                     // collapse space runs
    .replace(/\n{3,}/g, "\n\n")                     // collapse blank lines
    .trim();
}

/** Split the trailing "Follow-ups:" block into up to 3 suggestion strings. */
export function splitFollowups(text: string): { body: string; followups: string[] } {
  const i = text.search(/\n?\s*Follow-ups?:/i);
  if (i === -1) return { body: text, followups: [] };
  const body = text.slice(0, i).trim();
  const rest = text.slice(i).replace(/^\n?\s*Follow-ups?:/i, "").trim();
  const followups = rest
    .split(/\n|(?<=\?)\s+(?=[A-Z])/)
    .map((s) => s.replace(/^[-•*\d.\s]+/, "").trim())
    .filter((s) => s.length > 4)
    .slice(0, 3);
  return { body, followups };
}
