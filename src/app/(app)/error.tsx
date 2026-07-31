"use client";

// Error boundary for every /(app) page. Without this, an unhandled server/render
// error shows Next's raw crash screen. This catches it and offers a retry, so the
// sidebar/header stay and the user isn't dumped to a broken page.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <div className="text-4xl" aria-hidden="true">⚠️</div>
      <h1 className="mt-3 text-xl font-semibold text-slate-800">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-500">
        This page hit an unexpected error. You can retry, or head back to the dashboard.
      </p>
      {error?.digest && <p className="mt-1 font-mono text-xs text-slate-400">ref: {error.digest}</p>}
      <div className="mt-6 flex justify-center gap-3">
        <button onClick={reset} className="btn-primary">Try again</button>
        <a href="/dashboard" className="btn-secondary">Back to dashboard</a>
      </div>
    </div>
  );
}
