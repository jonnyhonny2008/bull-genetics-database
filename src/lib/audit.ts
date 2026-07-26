import "server-only";
import { prisma } from "./db";
import type { SessionUser } from "./auth";

export async function audit(
  user: SessionUser | null,
  entityType: string,
  action: string,
  entityId?: string,
  changes?: unknown,
  notes?: string,
) {
  await prisma.auditLog.create({
    data: {
      entityType,
      entityId,
      action,
      userId: user?.uid,
      userName: user?.name,
      changesJson: changes ? JSON.stringify(changes) : null,
      notes,
    },
  });
}
