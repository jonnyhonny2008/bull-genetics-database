// Three-generation family tree for a bull profile, rendered in the holstein.ca
// card format used by HolsteinFamilyTreeCard: one "Sire's line" band and one
// "Dam's line" band, each laid out as left-to-right generation columns
// (Parents → Grandparents → Great-grandparents) of small white ancestor cards.
//
// Dairy proof pedigrees are asymmetric — the sire is a leaf, but the maternal
// line runs back MGS/MGD → GMGS/GMGD — so the sire's band is one column deep
// and the dam's band is three. Keeping the two bands separate (rather than one
// flat grid) is what keeps the columns unambiguous: MGS/MGD are the DAM's
// parents, not the sire's. Ancestors we hold in our own database link through
// to /animals/{id} and show LPI + proven/genomic status; the rest render on a
// dashed, muted card with name + registration from the proof file. The three
// male-line ancestors that feed the Pedigree Index (sire ½, MGS ¼, GMGS ⅛)
// carry a weight chip so the index is legible straight from the tree.

import Link from "next/link";
import { Badge } from "@/components/ui";
import { INDEX_WEIGHTS, type Relation, type ResolvedAncestor } from "@/lib/pedigree";

const REL_LABEL: Record<Relation, string> = {
  sire: "Sire", dam: "Dam",
  mgs: "Maternal grandsire", mgd: "Maternal granddam",
  gmgs: "Great-mat. grandsire", gmgd: "Great-mat. granddam",
};
const WEIGHT_LABEL: Record<string, string> = { sire: "×½", mgs: "×¼", gmgs: "×⅛" };

// Generation column headers — same wording and order as HolsteinProfile's
// GEN_LABELS, but 0-indexed here (that one carries a leading "" and is read
// as GEN_LABELS[gi + 1] at HolsteinProfile.tsx:42).
const GEN_LABELS = ["Parents", "Grandparents", "Great-grandparents"];

// Which relations occupy each generation column of each lineage band.
const SIRE_LINE: Relation[][] = [["sire"]];
const DAM_LINE: Relation[][] = [["dam"], ["mgs", "mgd"], ["gmgs", "gmgd"]];

// Same shape as HolsteinProfile's AncestorCard: relation caption, name, then a
// reg + badge row and a muted key-info row. Ancestors we hold link through;
// the rest keep the dashed muted treatment so "on the proof but not in our
// database" stays readable at a glance.
function AncestorCard({ a }: { a: ResolvedAncestor }) {
  const lpi = a.evalValues?.lpi ?? null;
  const inDb = !!a.animalId;
  const weight = INDEX_WEIGHTS[a.relation] != null ? WEIGHT_LABEL[a.relation] : null;

  return (
    <div className={`rounded-md border p-2 text-xs shadow-sm ${inDb ? "border-slate-200 bg-white" : "border-dashed border-slate-200 bg-slate-50/60"}`}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{REL_LABEL[a.relation]}</div>

      <div className="mt-0.5 font-semibold text-slate-800">
        {inDb ? (
          <Link href={`/animals/${a.animalId}`} className="link">{a.name ?? "Unnamed"}</Link>
        ) : (
          a.name ?? <span className="font-normal text-slate-400">Unknown</span>
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        {a.reg
          ? <span className="font-mono text-[10px] text-slate-500">{a.reg}</span>
          : <span className="font-mono text-[10px] text-slate-400">—</span>}
        {a.sireType && (
          <Badge tone={a.sireType === "proven" ? "green" : "blue"}>{a.sireType === "proven" ? "Proven" : "Genomic"}</Badge>
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-slate-400">
        {lpi != null ? (
          <span className="font-semibold tabular-nums text-slate-600" title="LPI from this ancestor's preferred proof in our database">LPI {lpi}</span>
        ) : (
          <span>{inDb ? "no LPI" : "not in database"}</span>
        )}
        {weight && (
          <span title={`Feeds the Pedigree Index at weight ${weight}`}>· index {weight}</span>
        )}
      </div>
    </div>
  );
}

/**
 * One lineage band — generation columns left to right, same layout as
 * HolsteinProfile's Lineage. Trailing generations we hold nothing for are
 * dropped so a sire-only pedigree does not render two empty columns.
 */
function Lineage({
  title,
  columns,
  get,
}: {
  title: string;
  columns: Relation[][];
  get: (r: Relation) => ResolvedAncestor | null;
}) {
  const built = columns.map((rels) => rels.map(get).filter((a): a is ResolvedAncestor => !!a));
  const depth = built.reduce((d, col, i) => (col.length ? i + 1 : d), 0);
  if (depth === 0) return null;
  const cols = built.slice(0, depth);

  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {cols.map((col, gi) => (
          <div key={gi} className="min-w-[190px] flex-1 space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{GEN_LABELS[gi] ?? `Gen ${gi + 1}`}</div>
            {col.length > 0 ? (
              col.map((a) => <AncestorCard key={a.relation} a={a} />)
            ) : (
              <div className="rounded-md border border-dashed border-slate-200 p-2 text-[10px] text-slate-400">Not on the proof pedigree</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface PedigreeTreeSelf {
  name: string;
  reg: string | null;
  lpi: number | null;
  sireType: string | null;
  proofStatus: string | null;
}

export function PedigreeTree({ self, ancestors }: { self: PedigreeTreeSelf; ancestors: ResolvedAncestor[] }) {
  const by = new Map<Relation, ResolvedAncestor>();
  for (const a of ancestors) by.set(a.relation, a);
  const get = (r: Relation) => by.get(r) ?? null;

  if (ancestors.length === 0) {
    return <div className="text-sm text-slate-500">No pedigree on file for this animal.</div>;
  }

  return (
    <div className="space-y-4">
      {/* Subject — the animal both lines below belong to. Kept as a full-width
          strip rather than a column so neither lineage band has to repeat it. */}
      <div className="rounded-md border border-brand-200 bg-brand-50/50 p-2 text-xs shadow-sm">
        <div className="text-[10px] font-medium uppercase tracking-wide text-brand-600">This animal</div>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800">{self.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {self.reg
                ? <span className="font-mono text-[10px] text-slate-500">{self.reg}</span>
                : <span className="font-mono text-[10px] text-slate-400">—</span>}
              {self.sireType && (
                <Badge tone={self.sireType === "proven" ? "green" : "blue"}>{self.sireType === "proven" ? "Proven" : "Genomic"}</Badge>
              )}
            </div>
          </div>
          {self.lpi != null && (
            <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">LPI {self.lpi}</div>
          )}
        </div>
      </div>

      <Lineage title="Sire's line" columns={SIRE_LINE} get={get} />
      <Lineage title="Dam's line" columns={DAM_LINE} get={get} />
    </div>
  );
}
