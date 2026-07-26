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
              className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
                active ? "bg-brand-600 text-white" : "text-slate-200 hover:bg-brand-800 hover:text-white"
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
