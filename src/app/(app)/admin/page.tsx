import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { CA_ROSTER } from "@/lib/roster-scope";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { PageHeader, Card, Table, Badge } from "@/components/ui";
import { fmtDate, relTime } from "@/lib/format";
import { getAgentConfig, maskKey } from "@/lib/agent/config";
import { AGENT_TOOL_NAMES } from "@/lib/agent/agent";
import { saveAgentSettings, clearAgentKey } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");

  const [env, roles, configValues, audit, counts] = await Promise.all([
    prisma.environmentConfig.findMany(),
    prisma.role.findMany({ orderBy: { displayOrder: "asc" } }),
    prisma.configValue.findMany({ orderBy: [{ category: "asc" }, { displayOrder: "asc" }] }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    Promise.all([prisma.animal.count({ where: { archived: false, ...CA_ROSTER } }), prisma.user.count(), prisma.source.count(), prisma.traitDefinition.count()]),
  ]);
  const agentCfg = await getAgentConfig();
  const envMap = new Map(env.map((e) => [e.key, e.value]));
  const byCat = new Map<string, typeof configValues>();
  for (const c of configValues) { const a = byCat.get(c.category) ?? []; a.push(c); byCat.set(c.category, a); }

  return (
    <div>
      <PageHeader title="Admin Settings" subtitle="Roles, vocabularies, users, and configuration." />

      {/* Genetics Intelligence Agent — paste a key here to turn the assistant live. */}
      <Card
        title="AI Genetics Assistant"
        className="mb-4"
        actions={<Badge tone={agentCfg.configured ? "green" : "slate"}>{agentCfg.configured ? "Live" : "Not configured"}</Badge>}
      >
        <p className="mb-3 text-sm text-slate-600">
          The assistant is a genetics analyst that answers questions and investigates the database. It goes live the
          moment you save an Anthropic API key below — nothing is sent to Anthropic until then. The key is stored
          server-side and never shown again.
        </p>
        <form action={saveAgentSettings} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <label className="label">Anthropic API key {agentCfg.configured && <span className="text-slate-400">(currently {maskKey(agentCfg.apiKey)}{agentCfg.source === "env" ? ", from env" : ""})</span>}</label>
            <input name="anthropicApiKey" type="password" autoComplete="off" placeholder={agentCfg.configured ? "•••••• (leave blank to keep)" : "sk-ant-…"} className="input font-mono" />
          </div>
          <div>
            <label className="label">Model</label>
            <input name="model" defaultValue={agentCfg.model} className="input min-w-[160px]" />
          </div>
          <button type="submit" className="btn-primary">Save</button>
        </form>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-400">
          <span>Tools: {AGENT_TOOL_NAMES.join(", ")}.</span>
          {agentCfg.source === "settings" && (
            <form action={clearAgentKey}><button type="submit" className="link">Remove key (turn off)</button></form>
          )}
        </div>
      </Card>

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
