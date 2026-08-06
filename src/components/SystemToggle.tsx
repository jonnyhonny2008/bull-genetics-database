"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GENETIC_SYSTEMS, systemFromPathname, toSystem } from "@/lib/genetic-system";

/**
 * The CA | US switch in the header — the control that flips the whole app
 * between the Canadian and American programs.
 *
 * It is a pair of LINKS, not a button with state, so the system always lives in
 * the URL (see src/lib/genetic-system.ts for why that matters). Switching keeps
 * you on the same page where the other side has one — /animals <-> /us/animals.
 */
export function SystemToggle() {
  const pathname = usePathname() ?? "/";
  const current = systemFromPathname(pathname);

  return (
    <div
      role="group"
      aria-label="Genetic evaluation system"
      className="ml-3 flex items-center rounded-full bg-white/10 p-0.5 ring-1 ring-white/15"
    >
      {GENETIC_SYSTEMS.map((s) => {
        const active = s.key === current;
        return (
          <Link
            key={s.key}
            href={toSystem(pathname, s.key)}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            title={`${s.label} — ${s.hint}`}
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition ${
              active ? "bg-white text-navy-700 shadow-sm" : "text-slate-300 hover:text-white"
            }`}
          >
            {s.short}
          </Link>
        );
      })}
    </div>
  );
}
