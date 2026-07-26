import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Table, Badge } from "@/components/ui";
import { fmtDate, relTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");

  const [env, roles, configValues, audit, counts] = await Promise.all([
    prisma.environmentConfig.findMany(),
    prisma.role.findMany({ orderBy: { displayOrder: "asc" } }),
    prisma.configValue.findMany({ orderBy: [{ category: "asc" }, { displayOrder: "asc" }] }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    Promise.all([prisma.animal.count(), prisma.user.count(), prisma.source.count(), prisma.traitDefinition.count()]),
  ]);
  const envMap = new Map(env.map((e) => [e.key, e.value]));
  const byCat = new Map<string, typeof configValues>();
  for (const c of configValues) { const a = byCat.get(c.category) ?? []; a.push(c); byCat.set(c.category, a); }

  return (
    <div>
      <PageHeader title="Admin Settings" subtitle="Roles, vocabularies, users, and configuration." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="System">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Phase</dt><dd>{envMap.get("PHASE") ?? "1"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Animals</dt><dd>{counts[0]}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Users</dt><dd>{counts[1]}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Sources</dt><dd>{counts[2]}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Traits</dt><dd>{counts[3]}</dd></div>
          </dl>
        </Card>

        <Card title="Quick links">
          <ul className="space-y-1.5 text-sm">
            <li><Link className="link" href="/admin/users">Users & roles →</Link></li>
            <li><Link className="link" href="/admin/data-quality">Data quality & duplicates →</Link></li>
            <li><Link className="link" href="/breeds">Breeds →</Link></li>
            <li><Link className="link" href="/traits">Trait definitions →</Link></li>
            <li><Link className="link" href="/sources">Sources & priority rules →</Link></li>
          </ul>
        </Card>

        <Card title="Roles">
          <ul className="space-y-2 text-sm">
            {roles.map((r) => (
              <li key={r.id}>
                <div className="font-semibold">{r.roleName}</div>
                <div className="text-xs text-slate-500">{r.description}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Status & role vocabularies">
          <div className="space-y-3">
            {[...byCat.entries()].map(([cat, vals]) => (
              <div key={cat}>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{cat.replace(/_/g, " ")}</div>
                <div className="flex flex-wrap gap-1">
                  {vals.map((v) => <Badge key={v.id}>{v.label}</Badge>)}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Recent activity (audit log)">
          <Table head={<><th className="th">When</th><th className="th">Entity</th><th className="th">Action</th><th className="th">User</th></>}>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="td text-xs text-slate-400">{relTime(a.createdAt)}</td>
                <td className="td text-xs">{a.entityType}</td>
                <td className="td"><Badge>{a.action}</Badge></td>
                <td className="td text-xs">{a.userName ?? "system"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
