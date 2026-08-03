"use client";

// The sign-in screen. A wireframe cow materialises out of the dark, the panel
// slides in from the right, and a successful sign-in ignites her and carries
// straight through into the dashboard.
//
// The cow is the artwork itself, as a cut-out PNG with a real alpha channel, so
// it sits on the page with no backdrop to blend away and no rectangular seam.
// The points of light are a separate full-screen canvas that converges on the
// artwork's own measured vertices before it fades up beneath them.

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "./actions";
import { NodeAssembly, ASSEMBLE_SECONDS } from "./NodeAssembly";


function SubmitButton({ done }: { done: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || done}
      className="group relative w-full overflow-hidden rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] hover:scale-[1.02] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
      <span className="relative">{pending ? "Signing in…" : done ? "Welcome back" : "Sign in"}</span>
    </button>
  );
}

export function LoginExperience() {
  const [state, formAction] = useFormState<LoginState, FormData>(loginAction, {});
  const [assembled, setAssembled] = useState(false);
  const [panelIn, setPanelIn] = useState(false);
  const [igniting, setIgniting] = useState(false);
  const router = useRouter();
  const fired = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // the artwork fades up exactly as the points land on its vertices
    const a = window.setTimeout(() => setAssembled(true), reduced ? 0 : ASSEMBLE_SECONDS * 1000);
    const b = window.setTimeout(() => setPanelIn(true), reduced ? 0 : ASSEMBLE_SECONDS * 1000 + 550);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, []);

  // On success: ignite, then enter the app.
  useEffect(() => {
    if (!state?.ok || fired.current) return;
    fired.current = true;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) { router.push("/dashboard"); return; }
    setIgniting(true);
    const id = window.setTimeout(() => { router.push("/dashboard"); router.refresh(); }, 1050);
    return () => window.clearTimeout(id);
  }, [state, router]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0a1219] text-white">
      {/* the room she stands in */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(115% 85% at 40% 48%, #15303c 0%, #0f1e28 45%, #080f15 100%)" }}
      />

      {/* The artwork: a cut-out PNG with a real alpha channel, so it sits on the
          page with no backdrop to blend away and no rectangular seam. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 flex w-full items-center justify-center md:w-[62%] md:justify-end md:pr-6">
        <div
          ref={boxRef}
          className={`relative w-[94%] max-w-[720px] transition-transform duration-[900ms] ease-out md:w-full ${igniting ? "scale-110" : "scale-100"}`}
        >
          <Image
            src="/good-cow-removebg-preview.png"
            alt=""
            width={616}
            height={405}
            priority
            unoptimized
            className={`h-auto w-full select-none transition-opacity duration-[900ms] ease-out ${assembled && !igniting ? "opacity-100" : "opacity-0"}`}
            style={{ filter: "contrast(1.12) saturate(1.15) brightness(1.05)" }}
          />
        </div>
      </div>

      {/* Full-screen particle layer: the lights start anywhere on the page and
          converge on the artwork's own vertices, which is why it sits outside
          the image box rather than inside it. */}
      <NodeAssembly igniting={igniting} boxRef={boxRef} />

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

      {/* strapline + Blondin logo, bottom left */}
      <div className={`absolute bottom-6 left-6 z-20 transition-all duration-1000 sm:bottom-9 sm:left-10 ${panelIn ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>
        <div className="mb-4 max-w-xs">
          <p className="text-[13px] font-medium leading-relaxed text-slate-300/80">
            Every proof, every daughter, every round —
          </p>
          <p className="font-serif text-2xl italic leading-tight text-white sm:text-3xl">one complete animal.</p>
        </div>
        {/* The logo PNG is already 75% transparent, so it needs no panel behind
            it — but its greens are dark and would vanish against this
            background. Stacked white drop-shadows trace a thin outline around
            the artwork, which lifts it off the dark and reads as intended. */}
        <Image
          src="/BlondinSires.png"
          alt="Blondin Sires"
          width={140}
          height={88}
          priority
          className="h-auto w-[170px] select-none sm:w-[210px]"
          style={{
            filter:
              "drop-shadow(0 0 1px rgba(255,255,255,0.95)) drop-shadow(0 0 1px rgba(255,255,255,0.95)) drop-shadow(0 0 3px rgba(255,255,255,0.55)) brightness(1.12)",
          }}
        />
      </div>

      {/* sign-in panel — slides in from the right */}
      <div
        className={`absolute inset-y-0 right-0 z-20 flex w-full items-center justify-center px-5 transition-all duration-[900ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] sm:px-10 md:w-[44%] ${
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

            <SubmitButton done={!!state?.ok} />
          </form>
        </div>
      </div>

      {/* the flash carries into the app, so the cut is not abrupt */}
      <div className={`pointer-events-none absolute inset-0 z-30 bg-slate-100 transition-opacity duration-500 ${igniting ? "opacity-100 delay-[420ms]" : "opacity-0"}`} />
    </div>
  );
}
