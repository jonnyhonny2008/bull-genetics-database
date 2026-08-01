import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { PageHeader, Card, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

// Self-hosted error monitor: shows application errors captured to the audit log
// (entityType "app_error") by the error boundaries + logAppError. No external SaaS.
export default async function ErrorLogPage() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) redirect("/dashboard");

  const rows = await prisma.auditLog.findMany({
    where: { entityType: "app_error" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader title="Error Log" subtitle="Application errors captured in-app — no external service. Newest first, last 100." />
      {rows.length === 0 ? (
        <Card title="Errors"><EmptyState message="No errors logged. 🎉" /></Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            let d: { message?: string; stack?: string; digest?: string; url?: string; origin?: string; userName?: string } = {};
            try { d = JSON.parse(r.changesJson ?? "{}"); } catch { /* ignore */ }
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="red">error</Badge>
                  <span className="font-medium text-slate-800">{d.message || "(no message)"}</span>
                  {d.digest && <span className="font-mono text-xs text-slate-400">#{d.digest}</span>}
                  <span className="ml-auto font-mono text-xs text-slate-400">{r.createdAt.toISOString().slice(0, 19).replace("T", " ")} UTC</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  {r.notes && <span>{r.notes}</span>}
                  {d.origin && <span>· {d.origin}</span>}
                  {(r.userName || d.userName) && <span>· {r.userName ?? d.userName}</span>}
                  {d.url && <span className="max-w-full truncate">· {d.url}</span>}
                </div>
                {d.stack && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate-500">Stack trace</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">{d.stack}</pre>
                  </details>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
