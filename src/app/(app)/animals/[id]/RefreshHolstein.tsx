"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Convenience: re-scrape this animal from holstein.ca (live, all tabs) and
// refresh the profile in place. Requires the app running locally with Chrome.
export default function RefreshHolstein({ reg }: { reg: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/lactanet/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reg }) });
      const j = await r.json();
      if (j.ok) { setMsg("Updated"); router.refresh(); setTimeout(() => setMsg(null), 2500); }
      else setMsg(j.error ? `Failed: ${String(j.error).slice(0, 60)}` : "Failed");
    } catch (e) {
      setMsg("Failed: " + String(e).slice(0, 60));
    } finally { setBusy(false); }
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className={`text-xs ${msg.startsWith("Fail") ? "text-red-600" : "text-emerald-600"}`}>{msg}</span>}
      <button type="button" onClick={refresh} disabled={busy} className="btn-secondary" title="Re-scrape this animal from Holstein.ca">
        {busy ? "Refreshing…" : "↻ Holstein.ca"}
      </button>
    </div>
  );
}
