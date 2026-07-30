import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, ROLES } from "@/lib/constants";
import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { saveUser, deleteUser } from "@/app/(app)/admin/actions";
import { DeleteUserButton } from "@/components/DeleteUserButton";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = currentUser();
  if (!can(me?.role, "config:write")) redirect("/dashboard");
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <div>
      <PageHeader title="Users & Roles" subtitle="Create logins and assign roles. Passwords are stored as scrypt hashes." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Add user">
          <UserForm />
        </Card>
        <Card title={`Users (${users.length})`} className="lg:col-span-2">
          {users.length === 0 ? <EmptyState message="No users." /> : (
            <Table head={<><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Active</th><th className="th"></th></>}>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="td font-medium">{u.name}</td>
                  <td className="td text-xs">{u.email}</td>
                  <td className="td"><Badge tone="brand">{ROLES[u.role as keyof typeof ROLES] ?? u.role}</Badge></td>
                  <td className="td">{u.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</td>
                  <td className="td">
                    <details>
                      <summary className="link cursor-pointer text-xs">edit</summary>
                      <div className="mt-2 w-72 space-y-3">
                        <UserForm user={u} />
                        {me?.uid !== u.id && (
                          <div className="border-t border-slate-100 pt-3">
                            <DeleteUserButton id={u.id} name={u.name} action={deleteUser} />
                          </div>
                        )}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function UserForm({ user }: { user?: any }) {
  return (
    <form action={saveUser} className="space-y-2">
      {user && <input type="hidden" name="id" value={user.id} />}
      <div><label className="label">Name</label><input name="name" defaultValue={user?.name} className="input" required /></div>
      <div><label className="label">Email</label><input name="email" type="email" defaultValue={user?.email} className="input" required disabled={!!user} />{user && <input type="hidden" name="email" value={user.email} />}</div>
      <div><label className="label">Role</label>
        <select name="role" defaultValue={user?.role ?? "sales"} className="input">
          {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div><label className="label">{user ? "New password (blank = keep)" : "Password"}</label><input name="password" type="text" className="input" placeholder={user ? "leave blank to keep" : "set a password"} /></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={user ? user.active : true} /> Active</label>
      <button type="submit" className="btn-primary btn-sm">{user ? "Save" : "Add user"}</button>
    </form>
  );
}
