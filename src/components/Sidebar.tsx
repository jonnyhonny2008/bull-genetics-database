"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  group?: string;
}

// Inline line icons keyed by route — no icon-font dependency, matching the
// hand-rolled SVGs used elsewhere in the app. Presentational only; a route with
// no entry falls back to a blank slot so the labels stay aligned.
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const NAV_ICONS: Record<string, ReactNode> = {
  "/dashboard": <NavIcon><path d="M4 20h16" /><path d="M7 20v-6" /><path d="M12 20V6" /><path d="M17 20v-9" /></NavIcon>,
  // Cow / bull head — this is a cattle app, so Animals gets a cow, not a paw.
  "/animals": <NavIcon><path d="M3.5 5c2.2 0 3.9 1 4.9 2.8" /><path d="M20.5 5c-2.2 0-3.9 1-4.9 2.8" /><path d="M6.5 7.5h11V10a5.5 5.5 0 0 1-11 0z" /><path d="M9 13.7c0-1.4 1.3-2.3 3-2.3s3 .9 3 2.3-1.3 2.4-3 2.4-3-1-3-2.4z" /><path d="M11 13.8v.01" /><path d="M13 13.8v.01" /></NavIcon>,
  "/analysis": <NavIcon><path d="M4 16l5-5 4 4 7-7" /><path d="M17 8h4v4" /></NavIcon>,
  "/parent-average": <NavIcon><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M8.1 6.9c3 1 5.4 2.4 7.8 4.1M8.1 17.1c3-1 5.4-2.4 7.8-4.1" /></NavIcon>,
  "/reports": <NavIcon><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></NavIcon>,
  "/uploads": <NavIcon><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /><path d="M12 4v11" /><path d="M8 8l4-4 4 4" /></NavIcon>,
  "/import-proofs": <NavIcon><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 11v5" /><path d="M9.5 14l2.5 2.5L14.5 14" /></NavIcon>,
  "/animal-import": <NavIcon><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 20h16" /></NavIcon>,
  "/review": <NavIcon><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M9 3.5h6V6H9z" /><path d="M8.5 13l2.2 2.2L15 11" /></NavIcon>,
  "/sources": <NavIcon><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></NavIcon>,
  "/traits": <NavIcon><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="7" cy="17" r="2" /></NavIcon>,
  "/breeds": <NavIcon><path d="M3.6 12.4l8.8-8.8a1.7 1.7 0 0 1 1.2-.5H19a2 2 0 0 1 2 2v5.4a1.7 1.7 0 0 1-.5 1.2l-8.8 8.8a1.7 1.7 0 0 1-2.4 0l-5.7-5.7a1.7 1.7 0 0 1 0-2.4z" /><circle cx="16.4" cy="7.6" r="1.2" /></NavIcon>,
  "/admin": <NavIcon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></NavIcon>,
  "/admin/errors": <NavIcon><path d="M12 4l9 16H3z" /><path d="M12 10v4" /><path d="M12 17v.01" /></NavIcon>,
};

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  let lastGroup: string | undefined;

  return (
    <nav className="flex flex-col py-2 text-sm">
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
        const showGroup = item.group && item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <div key={item.href}>
            {showGroup && (
              <div className="px-4 pb-1 pt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
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
              className={`flex h-11 items-center gap-3 px-4 font-medium transition ${
                active ? "bg-brand-500 text-white" : "text-slate-300 hover:bg-navy-600 hover:text-white"
              }`}
            >
              {NAV_ICONS[item.href] ?? <span className="h-5 w-5 shrink-0" aria-hidden="true" />}
              <span>{item.label}</span>
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
