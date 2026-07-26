import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can, ROLES } from "@/lib/constants";
import { EnvBanner } from "@/components/EnvBanner";
import { Sidebar, type NavItem } from "@/components/Sidebar";
import { logoutAction } from "@/app/actions/session";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const user = currentUser();
  if (!user) redirect("/login");

  const all: (NavItem & { need?: string })[] = [
    { href: "/dashboard", label: "Dashboard", group: "Overview" },
    { href: "/animals", label: "Animals", group: "Records", need: "animal:read" },
    { href: "/proofs", label: "Genetic Proofs", group: "Records", need: "animal:read" },
    { href: "/milk", label: "Milk Records", group: "Records", need: "animal:read" },
    { href: "/classification", label: "Classification", group: "Records", need: "animal:read" },
    { href: "/comparison", label: "Comparisons", group: "Records", need: "compare:read" },
    { href: "/analysis", label: "Proof Trends", group: "Records", need: "compare:read" },
    { href: "/uploads", label: "Uploads", group: "Data In", need: "upload:write" },
    { href: "/import-proofs", label: "Proof Import", group: "Data In", need: "record:write" },
    { href: "/holstein-lookup", label: "Holstein.ca Lookup", group: "Data In", need: "upload:write" },
    { href: "/review", label: "Review Queue", group: "Data In", need: "review:write" },
    { href: "/sources", label: "Sources", group: "Configuration", need: "config:write" },
    { href: "/traits", label: "Traits", group: "Configuration", need: "config:write" },
    { href: "/breeds", label: "Breeds", group: "Configuration", need: "config:write" },
    { href: "/admin", label: "Admin Settings", group: "Configuration", need: "config:write" },
  ];
  const items = all.filter((i) => !i.need || can(user.role, i.need));

  return (
    <div className="min-h-screen">
      <EnvBanner />
      <div className="flex min-h-[calc(100vh-24px)]">
        <aside className="hidden w-60 shrink-0 flex-col bg-brand-900 md:flex">
          <div className="flex items-center gap-2 px-4 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">BS</div>
            <div className="leading-tight">
              <div className="text-sm font-bold text-white">Bull Stud Genetics</div>
              <div className="text-[10px] uppercase tracking-widest text-brand-300">Genetics Intelligence</div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <Sidebar items={items} />
          </div>
          <div className="border-t border-brand-800 p-3 text-[11px] text-brand-300">
            Phase 1 · Historical Proof DB
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
            <div className="text-sm text-slate-500 md:hidden">Bull Stud Genetics</div>
            <div className="ml-auto flex items-center gap-3">
              <div className="text-right leading-tight">
                <div className="text-sm font-medium text-slate-800">{user.name}</div>
                <div className="text-[11px] text-slate-500">{ROLES[user.role as keyof typeof ROLES] ?? user.role}</div>
              </div>
              <form action={logoutAction}>
                <button className="btn-secondary btn-sm" type="submit">Sign out</button>
              </form>
            </div>
          </header>
          <main className="flex-1 overflow-x-hidden p-5">{children}</main>
        </div>
      </div>
    </div>
  );
}
