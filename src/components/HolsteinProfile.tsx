import { Card, Badge } from "@/components/ui";
import type { HolsteinProfile, AncestorNode, Lactation } from "@/lib/holstein-parse";

// Per-section renderers for the rich Holstein.ca profile. Each takes the parsed
// HolsteinProfile and returns null when it has nothing to show, so the animal
// page can lay them out across holstein.ca-style tabs (Family Tree / Owner
// History / Progeny / Lactations / Show & Awards).

const GEN_LABELS = ["", "Parents", "Grandparents", "Great-grandparents", "Gen 4", "Gen 5"];
const n0 = (v: number | null) => (v == null ? "—" : v.toLocaleString());
const n1 = (v: number | null) => (v == null ? "—" : v.toFixed(1));

function aisUrl(reg: string) {
  return `https://www.holstein.ca/en/AIS/AIS?animalRegNo=${encodeURIComponent(reg)}`;
}

function AncestorCard({ n }: { n: AncestorNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2 text-xs shadow-sm">
      <div className="font-semibold text-slate-800">{n.name ?? "—"}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        {n.reg
          ? <a href={aisUrl(n.reg)} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-blue-600 hover:underline">{n.reg}</a>
          : <span className="font-mono text-[10px] text-slate-400">—</span>}
        {n.classification && <Badge tone="slate">{n.classification}</Badge>}
      </div>
      {n.birthDate && <div className="mt-0.5 text-[10px] text-slate-400">Born {n.birthDate}{n.extra ? ` · ${n.extra}` : ""}</div>}
    </div>
  );
}

function Lineage({ title, nodes }: { title: string; nodes: AncestorNode[] }) {
  if (!nodes.length) return null;
  const maxGen = Math.max(...nodes.map((n) => n.generation));
  const cols = Array.from({ length: maxGen }, (_, i) => nodes.filter((n) => n.generation === i + 1));
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {cols.map((col, gi) => (
          <div key={gi} className="min-w-[190px] flex-1 space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{GEN_LABELS[gi + 1] ?? `Gen ${gi + 1}`}</div>
            {col.map((n, i) => <AncestorCard key={i} n={n} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function HolsteinFamilyTreeCard({ profile }: { profile: HolsteinProfile }) {
  if (!profile.familyTree.length) return null;
  const sire = profile.familyTree.filter((n) => n.side === "sire");
  const dam = profile.familyTree.filter((n) => n.side === "dam");
  return (
    <Card title="Family tree — Holstein.ca" actions={<span className="text-xs text-slate-400">{profile.familyTree.length} ancestors{profile.scrapedAt ? ` · scraped ${profile.scrapedAt.slice(0, 10)}` : ""}</span>}>
      <div className="space-y-4">
        <Lineage title="Sire's line" nodes={sire} />
        <Lineage title="Dam's line" nodes={dam} />
      </div>
    </Card>
  );
}

export function HolsteinOwnersCard({ profile }: { profile: HolsteinProfile }) {
  if (!profile.owners.length && !profile.breeders.length) return null;
  return (
    <Card title="Owners &amp; breeders">
      {profile.breeders.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Breeder</div>
          {profile.breeders.map((b, i) => <div key={i} className="text-sm text-slate-700">{b.name}{b.prefix ? ` (${b.prefix})` : ""}</div>)}
        </div>
      )}
      {profile.owners.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-1 pr-3">Owner</th><th className="py-1 pr-3">Prefix</th><th className="py-1 pr-3">Address</th><th className="py-1 pr-3">Since</th><th className="py-1">Status</th>
            </tr></thead>
            <tbody>
              {profile.owners.map((o, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-3 font-medium text-slate-800">{o.name ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-xs text-slate-500">{o.prefix ?? "—"}</td>
                  <td className="py-1 pr-3 text-xs text-slate-500">{o.address ?? "—"}</td>
                  <td className="py-1 pr-3 text-xs text-slate-500">{o.date ?? "—"}</td>
                  <td className="py-1">{o.current ? <Badge tone="green">current</Badge> : <Badge tone="slate">past</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function HolsteinProgenyCard({ profile }: { profile: HolsteinProfile }) {
  if (!profile.progeny.length) return null;
  return (
    <Card title="Progeny" actions={<span className="text-xs text-slate-400">{profile.progeny.length}</span>}>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-1 pr-3">Reg #</th><th className="py-1 pr-3">Name</th><th className="py-1 pr-3">Born</th><th className="py-1 pr-3">Colour</th><th className="py-1">Class</th>
          </tr></thead>
          <tbody>
            {profile.progeny.map((p, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1 pr-3">{p.reg ? <a href={aisUrl(p.reg)} target="_blank" rel="noreferrer" className="font-mono text-xs text-blue-600 hover:underline">{p.reg}</a> : "—"}</td>
                <td className="py-1 pr-3 text-slate-800">{p.name ?? "—"}</td>
                <td className="py-1 pr-3 text-xs text-slate-500">{p.birthDate ?? "—"}</td>
                <td className="py-1 pr-3 text-xs text-slate-500">{p.colour ?? "—"}</td>
                <td className="py-1 text-xs">{p.classification ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function HolsteinAwardsCard({ profile }: { profile: HolsteinProfile }) {
  if (!profile.awards.length) return null;
  return (
    <Card title="Shows &amp; awards">
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
        {profile.awards.map((a, i) => <li key={i}>{a}</li>)}
      </ul>
    </Card>
  );
}

// Lactation / milk records — the "Production" table from holstein.ca (305-day
// standardized rows with BCA).
export function HolsteinLactationsCard({ profile }: { profile: HolsteinProfile }) {
  const ls: Lactation[] = profile.lactations ?? [];
  if (!ls.length) return null;
  const sum = (pick: (l: Lactation) => number | null) => ls.reduce((a, l) => a + (pick(l) ?? 0), 0);
  return (
    <Card title="Lactation records" actions={<span className="text-xs text-slate-400">{ls.length} lactation{ls.length === 1 ? "" : "s"} · 305-day, kg</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-1 pr-3">Lact.</th><th className="py-1 pr-3">Calved</th><th className="py-1 pr-3">Age</th><th className="py-1 pr-3">Freq</th><th className="py-1 pr-3">DIM</th>
              <th className="py-1 pr-3 text-right">Milk</th><th className="py-1 pr-3 text-right">Fat</th><th className="py-1 pr-3 text-right">%F</th>
              <th className="py-1 pr-3 text-right">Prot</th><th className="py-1 pr-3 text-right">%P</th><th className="py-1 pr-3 text-right">BCA (M/F/P)</th>
            </tr>
          </thead>
          <tbody>
            {ls.map((l) => (
              <tr key={l.lactationNumber} className="border-t border-slate-100">
                <td className="py-1 pr-3 font-medium">{l.lactationNumber}</td>
                <td className="py-1 pr-3 text-xs text-slate-500">{l.calvingDateIso ?? "—"}</td>
                <td className="py-1 pr-3 text-xs text-slate-500">{l.ageAtCalving ?? "—"}</td>
                <td className="py-1 pr-3 text-xs text-slate-500">{l.milkingFreq ?? "—"}</td>
                <td className="py-1 pr-3">{l.dim ?? "—"}</td>
                <td className="py-1 pr-3 text-right font-mono">{n0(l.milk)}</td>
                <td className="py-1 pr-3 text-right font-mono">{n0(l.fat)}</td>
                <td className="py-1 pr-3 text-right font-mono">{n1(l.fatPct)}</td>
                <td className="py-1 pr-3 text-right font-mono">{n0(l.prot)}</td>
                <td className="py-1 pr-3 text-right font-mono">{n1(l.protPct)}</td>
                <td className="py-1 pr-3 text-right font-mono text-xs text-slate-500">{[l.bca.milk, l.bca.fat, l.bca.prot].map((x) => x ?? "—").join(" / ")}</td>
              </tr>
            ))}
            {ls.length > 1 && (
              <tr className="border-t-2 border-slate-200 font-semibold">
                <td className="py-1 pr-3" colSpan={5}>{ls.length} lactations (total)</td>
                <td className="py-1 pr-3 text-right font-mono">{n0(sum((l) => l.milk))}</td>
                <td className="py-1 pr-3 text-right font-mono">{n0(sum((l) => l.fat))}</td>
                <td className="py-1 pr-3"></td>
                <td className="py-1 pr-3 text-right font-mono">{n0(sum((l) => l.prot))}</td>
                <td className="py-1 pr-3"></td><td className="py-1 pr-3"></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">305-day standardized records from Holstein.ca. BCA = Breed Class Average (M=milk, F=fat, P=protein). Calving date is derived from age at calving + birth date.</p>
    </Card>
  );
}
