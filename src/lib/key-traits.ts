// ---------------------------------------------------------------------------
// The traits the stud actually watches — one definition, read by every report.
//
// Pure: no prisma, no "server-only", so the pure scoring modules and their unit
// tests can read it as well as the server-side report builders.
//
// This list used to live in proof-change.ts, which imports prisma. The Mating
// Program needs the same nine traits so a bull reads the same across reports,
// and could not import them without pulling a database client into a pure
// module. Extracted here rather than copied, because two lists that are meant
// to be identical will not stay identical.
// ---------------------------------------------------------------------------

/** The nine traits every report focuses on, in display order. */
export const KEY_TRAITS: { code: string; label: string }[] = [
  { code: "CONF", label: "Conformation" },
  { code: "LPI", label: "LPI" },
  { code: "MILK", label: "Milk" },
  { code: "FAT", label: "Fat" },
  { code: "FATPCT", label: "Fat %" },
  { code: "PROT", label: "Protein" },
  { code: "PROTPCT", label: "Protein %" },
  { code: "MSPD", label: "Milking Speed" },
  { code: "DF", label: "Daughter Fertility" },
];

export const KEY_TRAIT_CODES = KEY_TRAITS.map((t) => t.code);
