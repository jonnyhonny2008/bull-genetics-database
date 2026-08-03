import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { can, ROLES } from "@/lib/constants";
import { EnvBanner } from "@/components/EnvBanner";
import { type NavItem } from "@/components/Sidebar";
import { NavProvider, NavToggle, AppSidebar } from "@/components/AppNav";
import { logoutAction } from "@/app/actions/session";
import { GeneticsAssistant } from "@/components/GeneticsAssistant";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const user = currentUser();
  if (!user) redirect("/login");

  const all: (NavItem & { need?: string })[] = [
    { href: "/dashboard", label: "Dashboard", group: "Overview" },
    { href: "/animals", label: "Animals", group: "Records", need: "animal:read" },
    { href: "/analysis", label: "Proof Trends", group: "Records", need: "compare:read" },
    { href: "/parent-average", label: "Parent Average", group: "Records", need: "compare:read" },
    { href: "/reports", label: "Reports", group: "Records", need: "compare:read" },
    { href: "/uploads", label: "Uploads", group: "Data In", need: "upload:write" },
    { href: "/import-proofs", label: "Proof Import", group: "Data In", need: "record:write" },
    { href: "/animal-import", label: "Animal Import", group: "Data In", need: "upload:write" },
    { href: "/review", label: "Review Queue", group: "Data In", need: "review:write" },
    { href: "/sources", label: "Sources", group: "Configuration", need: "config:write" },
    { href: "/traits", label: "Traits", group: "Configuration", need: "config:write" },
    { href: "/breeds", label: "Breeds", group: "Configuration", need: "config:write" },
    { href: "/admin", label: "Admin Settings", group: "Configuration", need: "config:write" },
    { href: "/admin/errors", label: "Error Log", group: "Configuration", need: "config:write" },
  ];
  const items = all.filter((i) => !i.need || can(user.role, i.need));

  return (
    <NavProvider>
    <div className="flex min-h-screen flex-col">
      <EnvBanner />
      {/* Full-width top banner spanning the whole screen — the GenetiBase
          wordmark sits above the sidebar's Blondin logo. h-14 is fixed so the
          sidebar below can offset by exactly that height (md:top-14). */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-navy-800 bg-navy-700 px-4">
        <div className="flex items-center gap-2">
          <NavToggle />
          <span className="font-serif text-lg font-bold tracking-tight text-white">GenetiBase</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right leading-tight">
            <div className="text-sm font-medium text-white">{user.name}</div>
            <div className="text-[11px] text-slate-300">{ROLES[user.role as keyof typeof ROLES] ?? user.role}</div>
          </div>
          <form action={logoutAction}>
            <button className="btn-secondary btn-sm" type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <div className="flex flex-1">
        {/* Desktop sidebar (collapsible) + mobile drawer. It sticks below the
            banner (md:top-14) and fills the rest of the viewport height. */}
        <AppSidebar items={items} />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* pb-24 keeps the floating assistant button from covering page content.
              overflow-x-CLIP (not hidden): `hidden` makes this a scroll container,
              which silently disables `position: sticky` for everything inside —
              `clip` contains overflow the same way without that side effect. */}
          <main className="flex-1 overflow-x-clip p-5 pb-24">{children}</main>
        </div>
      </div>
      <GeneticsAssistant />
    </div>
    </NavProvider>
  );
}
