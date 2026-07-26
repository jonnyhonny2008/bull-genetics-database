import { isDemo } from "@/lib/env";

// Environment marker. Production shows NOTHING — it is the real, live app and
// should read as a finished product, not a labelled deployment. Only the demo
// environment gets a banner, so testers know the data is disposable.
export function EnvBanner() {
  if (!isDemo()) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-1 text-center text-xs font-bold uppercase tracking-widest text-black">
      <span>▲</span>
      <span>Demo environment</span>
      <span className="hidden sm:inline">— seeded sample data. Safe to test, reset &amp; reseed.</span>
    </div>
  );
}
