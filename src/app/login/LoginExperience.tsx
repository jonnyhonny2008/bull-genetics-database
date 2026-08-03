"use client";

// The sign-in screen. The constellation assembles behind; the panel slides in
// from the right once the cow has read; a successful sign-in ignites the herd
// and carries straight into the dashboard.

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { CowConstellation } from "./CowConstellation";
import { loginAction, type LoginState } from "./actions";

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="group relative w-full overflow-hidden rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] hover:scale-[1.02] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {/* sliding sheen on hover */}
      <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
      <span className="relative">{pending ? "Signing in…" : disabled ? "Welcome back" : "Sign in"}</span>
    </button>
  );
}

export function LoginExperience({ isDemo, demoLogins }: { isDemo: boolean; demoLogins: { role: string; email: string; pw: string }[] }) {
  const [state, formAction] = useFormState<LoginState, FormData>(loginAction, {});
  const [panelIn, setPanelIn] = useState(false);
  const [igniting, setIgniting] = useState(false);
  const router = useRouter();
  const fired = useRef(false);

  // Let the cow assemble before the panel arrives.
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const id = window.setTimeout(() => setPanelIn(true), reduced ? 0 : 2100);
    return () => window.clearTimeout(id);
  }, []);

  // On success: ignite, then enter the app.
  useEffect(() => {
    if (!state?.ok || fired.current) return;
    fired.current = true;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) { router.push("/dashboard"); return; }
    setIgniting(true);
    const id = window.setTimeout(() => { router.push("/dashboard"); router.refresh(); }, 1150);
    return () => window.clearTimeout(id);
  }, [state, router]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-navy-900 text-white">
      {/* deep radial wash so the points sit in a room, not on flat black */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(120% 90% at 42% 45%, #16323f 0%, #101d27 45%, #0a1219 100%)" }}
      />
      <CowConstellation igniting={igniting} />

      {/* film grain — kills banding in the gradient */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.05] mix-blend-overlay"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")" }}
      />

      {/* wordmark, top left */}
      <div className={`absolute left-6 top-6 z-20 transition-all duration-1000 sm:left-10 sm:top-9 ${panelIn ? "opacity-100" : "opacity-0"}`}>
        <div className="font-serif text-xl font-bold tracking-tight text-white sm:text-2xl">GenetiBase</div>
        <div className="mt-1 text-[10px] uppercase tracking-[0.28em] text-brand-300/80">Genetics Intelligence</div>
      </div>

      {/* Blondin logo + the line that tells you what you are looking at, stacked
          in the bottom-left corner so neither crosses the animal. */}
      <div className={`absolute bottom-6 left-6 z-20 transition-all duration-1000 sm:bottom-9 sm:left-10 ${panelIn ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
        <div className="mb-4 max-w-xs">
          <p className="text-[13px] font-medium leading-relaxed text-slate-300/80">
            Every proof, every daughter, every round —
          </p>
          <p className="font-serif text-2xl italic leading-tight text-white sm:text-3xl">one complete animal.</p>
        </div>
        <div className="inline-block rounded-2xl bg-white/95 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur">
          <Image src="/BlondinSires.png" alt="Blondin Sires" width={150} height={94} priority className="h-auto w-[118px] sm:w-[140px]" />
        </div>
      </div>

      {/* sign-in panel — slides in from the right */}
      <div
        className={`absolute inset-y-0 right-0 z-20 flex w-full items-center justify-center px-5 transition-all duration-[900ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] sm:px-10 md:w-[46%] ${
          panelIn && !igniting ? "translate-x-0 opacity-100" : "translate-x-10 opacity-0"
        }`}
      >
        <div className="w-full max-w-sm rounded-[2rem] border border-white/10 bg-white/[0.07] p-7 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8">
          <h1 className="text-lg font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-xs text-slate-300/80">Blondin Sires · genetics intelligence platform</p>

          <form action={formAction} className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-300/80" htmlFor="email">Email</label>
              <input
                id="email" name="email" type="email" autoComplete="username" required
                className="w-full rounded-xl border border-white/12 bg-white/[0.06] px-3.5 py-2.5 text-sm text-white placeholder-slate-400/60 outline-none transition focus:border-brand-400/70 focus:bg-white/[0.09] focus:ring-2 focus:ring-brand-400/25"
                placeholder="name@blondinsires.com"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-300/80" htmlFor="password">Password</label>
              <input
                id="password" name="password" type="password" autoComplete="current-password" required
                className="w-full rounded-xl border border-white/12 bg-white/[0.06] px-3.5 py-2.5 text-sm text-white placeholder-slate-400/60 outline-none transition focus:border-brand-400/70 focus:bg-white/[0.09] focus:ring-2 focus:ring-brand-400/25"
                placeholder="••••••••"
              />
            </div>

            {state?.error && (
              <div className="rounded-xl border border-red-400/25 bg-red-500/12 px-3 py-2 text-xs text-red-200">{state.error}</div>
            )}

            <SubmitButton disabled={!!state?.ok} />
          </form>

          {isDemo && (
            <div className="mt-6 border-t border-white/10 pt-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-300/80">Demo environment</div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                Seeded sample data — safe to test, reset and reseed.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* the flash carries into the app, so the cut is not abrupt */}
      <div className={`pointer-events-none absolute inset-0 z-30 bg-slate-100 transition-opacity duration-500 ${igniting ? "opacity-100 delay-500" : "opacity-0"}`} />
    </div>
  );
}
