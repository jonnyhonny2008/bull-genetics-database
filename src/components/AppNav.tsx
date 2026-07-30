"use client";

// ---------------------------------------------------------------------------
// App navigation chrome.
//
// Before this, the sidebar was `hidden md:flex` with no toggle anywhere, so on a
// phone there was NO way to navigate at all. Now:
//
//   • mobile (< md) — a hamburger in the header opens a slide-over drawer.
//     Closes on link tap, on Escape, on overlay tap, and on route change.
//   • desktop (>= md) — the sidebar can be collapsed away to hand the full width
//     to the page, and the choice is remembered across visits.
//
// State lives in a context so the header button and the sidebar can talk to each
// other without turning the whole (server-rendered) layout into a client tree.
// ---------------------------------------------------------------------------

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { Sidebar, type NavItem } from "@/components/Sidebar";

const STORAGE_KEY = "bsg.nav.collapsed";

interface NavState {
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}
const Ctx = createContext<NavState | null>(null);

function useNav(): NavState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useNav must be used inside <NavProvider>");
  return c;
}

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Start expanded so server and first client render agree (no hydration
  // mismatch); the stored preference is applied in an effect straight after.
  const [collapsed, setCollapsedState] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsedState(true);
    } catch { /* private mode / storage disabled — just stay expanded */ }
  }, []);

  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try { window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  };

  // Navigating always dismisses the mobile drawer.
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Escape closes the drawer; also stop the page scrolling behind it.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  return (
    <Ctx.Provider value={{ mobileOpen, setMobileOpen, collapsed, setCollapsed }}>
      {children}
    </Ctx.Provider>
  );
}

function BurgerIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {open ? (
        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <>
          <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/**
 * Header controls. Two buttons rather than one media-query-aware button, so the
 * correct affordance is chosen by CSS and works before JS decides anything.
 */
export function NavToggle() {
  const { mobileOpen, setMobileOpen, collapsed, setCollapsed } = useNav();
  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? "Close menu" : "Open menu"}
        aria-expanded={mobileOpen}
        aria-controls="app-nav-drawer"
        className="-ml-1 inline-flex items-center justify-center rounded-md p-2 text-slate-600 hover:bg-slate-100 md:hidden"
      >
        <BurgerIcon open={mobileOpen} />
      </button>

      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? "Show navigation" : "Hide navigation"}
        aria-expanded={!collapsed}
        title={collapsed ? "Show navigation" : "Hide navigation for more room"}
        className="-ml-1 hidden items-center justify-center rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 md:inline-flex"
      >
        <BurgerIcon open={false} />
      </button>
    </>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-4 py-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">BS</div>
      <div className="leading-tight">
        <div className="text-sm font-bold text-white">Bull Stud Genetics</div>
        <div className="text-[10px] uppercase tracking-widest text-brand-300">Genetics Intelligence</div>
      </div>
    </div>
  );
}

/** Desktop sidebar (collapsible) + the mobile slide-over drawer. */
export function AppSidebar({ items }: { items: NavItem[] }) {
  const { mobileOpen, setMobileOpen, collapsed } = useNav();

  return (
    <>
      {/* ---- desktop ---- */}
      <aside
        className={`hidden w-60 shrink-0 flex-col bg-brand-900 md:sticky md:top-0 md:h-screen md:self-start ${
          collapsed ? "md:hidden" : "md:flex"
        }`}
      >
        <Brand />
        <div className="flex-1 overflow-y-auto">
          <Sidebar items={items} />
        </div>
        <div className="border-t border-brand-800 p-3 text-[11px] text-brand-300">
          Phase 1 · Historical Proof DB
        </div>
      </aside>

      {/* ---- mobile drawer ---- */}
      <div
        className={`fixed inset-0 z-40 md:hidden ${mobileOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!mobileOpen}
      >
        <div
          onClick={() => setMobileOpen(false)}
          className={`absolute inset-0 bg-slate-900/50 transition-opacity duration-200 ${
            mobileOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          id="app-nav-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-brand-900 shadow-xl transition-transform duration-200 ease-out ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-start justify-between">
            <Brand />
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="m-3 rounded-md p-2 text-brand-200 hover:bg-brand-800 hover:text-white"
            >
              <BurgerIcon open />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <Sidebar items={items} />
          </div>
          <div className="border-t border-brand-800 p-3 text-[11px] text-brand-300">
            Phase 1 · Historical Proof DB
          </div>
        </div>
      </div>
    </>
  );
}
