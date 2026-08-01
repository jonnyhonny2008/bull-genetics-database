"use client";

import { useEffect } from "react";

// Root error boundary — catches errors thrown by the root layout itself (which
// (app)/error.tsx cannot). Must render its own <html>/<body>. Kept dependency-free
// and inline-styled so it works even if the app's CSS failed to load. Also reports
// to the self-hosted error log.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    fetch("/api/log-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "global-error-boundary",
        message: error?.message,
        stack: error?.stack,
        digest: error?.digest,
        url: typeof window !== "undefined" ? window.location.href : "",
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: "4rem 1.5rem", textAlign: "center", color: "#0f172a" }}>
        <div style={{ fontSize: "2.25rem" }} aria-hidden="true">⚠️</div>
        <h1 style={{ marginTop: "0.75rem", fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ marginTop: "0.5rem", color: "#64748b", fontSize: "0.9rem" }}>The application hit an unexpected error.</p>
        {error?.digest && <p style={{ marginTop: "0.25rem", fontFamily: "monospace", fontSize: "0.75rem", color: "#94a3b8" }}>ref: {error.digest}</p>}
        <button
          onClick={() => reset()}
          style={{ marginTop: "1.5rem", padding: "0.5rem 1rem", borderRadius: "0.375rem", background: "#337ab7", color: "#fff", border: 0, cursor: "pointer", fontSize: "0.875rem" }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
