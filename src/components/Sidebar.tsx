"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  group?: string;
}

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  let lastGroup: string | undefined;

  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
        const showGroup = item.group && item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <div key={item.href}>
            {showGroup && (
              <div className="mb-1 mt-3 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {item.group}
              </div>
            )}
            <Link
              href={item.href}
              // prefetch={false} is load-bearing, not a micro-optimisation.
              // Every destination here is `dynamic = "force-dynamic"`, so a
              // prefetch is a FULL server render that opens database
              // connections. With ~12 links rendered twice (desktop sidebar +
              // mobile drawer), Next would fire ~24 renders the moment the nav
              // mounted and blow straight through Supabase's connection cap:
              //   FATAL: (EMAXCONNSESSION) max clients reached ... pool_size: 15
              // Navigation is still instant enough; correctness wins here.
              prefetch={false}
              className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
                active ? "bg-brand-600 text-white" : "text-slate-200 hover:bg-navy-600 hover:text-white"
              }`}
            >
              {item.label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
