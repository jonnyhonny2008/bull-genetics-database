import "server-only";
import { prisma } from "./db";

// Lightweight, self-hosted error monitoring — no external service. Errors are
// recorded as AuditLog rows (entityType "app_error") and surfaced at /admin/errors.
// Writing never throws: a logging failure must not mask the original error.
export async function logAppError(
  source: string,
  error: unknown,
  meta: Record<string, unknown> & { userId?: string | null; userName?: string | null } = {},
): Promise<void> {
  try {
    const e = error as { message?: string; stack?: string; digest?: string };
    const { userId, userName, ...rest } = meta;
    await prisma.auditLog.create({
      data: {
        entityType: "app_error",
        action: "error",
        userId: userId ?? undefined,
        userName: userName ?? undefined,
        notes: String(source).slice(0, 200),
        changesJson: JSON.stringify({
          message: String(e?.message ?? error).slice(0, 2000),
          stack: e?.stack ? String(e.stack).slice(0, 4000) : null,
          digest: e?.digest ?? null,
          ...rest,
        }),
      },
    });
  } catch {
    /* never let logging throw */
  }
}
