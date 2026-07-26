// Central vocabularies. SQLite has no enums, so these constants are the source
// of truth for the string values used across the app. They are also mirrored
// into the ConfigValue table by the config seed so Admin can view them.

export const ROLES = {
  admin: "Admin",
  staff: "Staff",
  sales: "Sales",
  consultant: "Genetic Consultant",
} as const;
export type RoleKey = keyof typeof ROLES;

// Capability model — coarse-grained, checked in server actions & UI.
export const CAPABILITIES = {
  admin: [
    "animal:read", "animal:write", "record:write", "record:approve",
    "upload:write", "review:write", "config:write", "user:write", "compare:read",
  ],
  staff: [
    "animal:read", "animal:write", "record:write",
    "upload:write", "review:write", "compare:read",
  ],
  sales: ["animal:read", "compare:read"],
  consultant: ["animal:read", "compare:read", "history:read"],
} as const;

export function can(role: string | undefined, capability: string): boolean {
  if (!role) return false;
  const caps = (CAPABILITIES as Record<string, readonly string[]>)[role] ?? [];
  return caps.includes(capability);
}

export const SEXES = { M: "Male", F: "Female" } as const;

export const COUNTRIES = [
  { code: "CA", label: "Canada" },
  { code: "US", label: "United States" },
  { code: "INT", label: "International" },
];

export const ANIMAL_STATUSES = [
  { code: "active", label: "Active" },
  { code: "proven", label: "Proven" },
  { code: "genomic", label: "Genomic (young)" },
  { code: "retired", label: "Retired" },
  { code: "reference", label: "Reference" },
  { code: "archived", label: "Archived" },
];

// NOTE: the hand-assigned 14-role vocabulary that used to live here has been
// retired. Sire roles are now derived from the imported Lactanet proofs —
// proven/genomic from the proof activity code, active/inactive from whether the
// sire appears in the most recent round on file. See src/lib/sire-class.ts.
//
// The AnimalRole table and any legacy rows are left in place (nothing is
// deleted), they are simply no longer surfaced or written by the UI.

export const ID_TYPES = [
  { code: "registration_ca", label: "Canadian registration number" },
  { code: "registration_us", label: "United States registration number" },
  { code: "registration_int", label: "International registration number" },
  { code: "naab", label: "NAAB code" },
  { code: "semen_code", label: "Semen code" },
  { code: "rfid", label: "RFID" },
  { code: "tattoo", label: "Tattoo" },
  { code: "ear_tag", label: "Ear tag" },
  { code: "breed_assoc", label: "Breed association ID" },
  { code: "lactanetgen", label: "LactanetGen identifier" },
  { code: "holstein_ca", label: "Holstein Canada identifier" },
  { code: "internal_stud", label: "Internal stud code" },
  { code: "interbull", label: "Interbull-style identifier" },
  { code: "marketing_code", label: "Marketing code" },
  { code: "legacy_code", label: "Legacy code" },
];

export const APPROVAL_STATUSES = [
  { code: "pending", label: "Pending" },
  { code: "approved", label: "Approved" },
  { code: "rejected", label: "Rejected" },
];

export const REVIEW_STATUSES = [
  { code: "pending", label: "Pending" },
  { code: "approved", label: "Approved" },
  { code: "rejected", label: "Rejected" },
  { code: "needs_more_info", label: "Needs more info" },
  { code: "duplicate", label: "Duplicate" },
  { code: "conflict_review", label: "Conflict review" },
];

export const DATA_DOMAINS = [
  { code: "genetic_evaluation", label: "Genetic evaluations" },
  { code: "classification", label: "Classification" },
  { code: "milk_record", label: "Milk records" },
  { code: "animal_identity", label: "Animal identity" },
  { code: "pedigree_display", label: "Pedigree display" },
];

export const SOURCE_TYPES = [
  { code: "official_portal", label: "Official portal (link only)" },
  { code: "uploaded_report", label: "Official uploaded report" },
  { code: "registry", label: "Breed association / registry" },
  { code: "manual", label: "Manual entry" },
  { code: "ai_extraction", label: "AI-extracted PDF / screenshot" },
  { code: "catalogue", label: "Catalogue PDF / marketing" },
];

export const CAPTURE_TYPES = [
  { code: "csv", label: "CSV" },
  { code: "excel", label: "Excel" },
  { code: "pdf", label: "PDF" },
  { code: "image", label: "Screenshot / image" },
  { code: "report", label: "Official report" },
  { code: "manual", label: "Manual entry" },
  { code: "browser_lookup", label: "Browser-assisted lookup" },
];

export const RECORD_TYPES = [
  { code: "genetic_evaluation", label: "Genetic evaluation" },
  { code: "milk_record", label: "Milk record" },
  { code: "classification", label: "Classification record" },
  { code: "animal", label: "New animal" },
  { code: "identifier", label: "Identifier" },
];

export const SPECIES_TYPES = [
  { code: "dairy", label: "Dairy" },
  { code: "beef", label: "Beef" },
  { code: "both", label: "Both" },
];

export function label(list: { code: string; label: string }[], code?: string | null): string {
  if (!code) return "—";
  return list.find((x) => x.code === code)?.label ?? code;
}
