import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { isDemo } from "@/lib/env";
import { LoginForm } from "./LoginForm";

const DEMO_LOGINS = [
  { role: "Admin", email: "admin@studgenetics.local", pw: "Admin#12345" },
  { role: "Staff", email: "staff@studgenetics.local", pw: "Staff#12345" },
  { role: "Sales", email: "sales@studgenetics.local", pw: "Sales#12345" },
  { role: "Consultant", email: "consultant@studgenetics.local", pw: "Consult#12345" },
];

export default function LoginPage() {
  if (currentUser()) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md">
        {isDemo() && (
          <div className="mb-3 rounded-md bg-amber-500 px-3 py-1 text-center text-xs font-bold uppercase tracking-widest text-black">
            Demo environment
          </div>
        )}
        <div className="card card-pad">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-accent-500 to-red-500 text-xl font-bold text-white">
              BS
            </div>
            <h1 className="text-lg font-bold text-slate-900">Bull Stud Genetics</h1>
            <p className="text-xs text-slate-500">Genetics Intelligence Platform · Phase 1</p>
          </div>
          <LoginForm />
        </div>

        {isDemo() && (
          <div className="card card-pad mt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Demo logins</div>
            <table className="w-full text-xs">
              <tbody>
                {DEMO_LOGINS.map((l) => (
                  <tr key={l.email} className="border-t border-slate-100">
                    <td className="py-1 pr-2 font-medium text-slate-700">{l.role}</td>
                    <td className="py-1 pr-2 text-slate-600">{l.email}</td>
                    <td className="py-1 font-mono text-slate-500">{l.pw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-slate-400">These accounts exist only in the demo environment.</p>
          </div>
        )}
      </div>
    </div>
  );
}
