// Instant-navigation skeleton for every /(app) page.
//
// Every page in this group is `force-dynamic` and runs DB queries before it can
// render. Without a loading fallback, Next.js BLOCKS the navigation: clicking a
// nav tab leaves the old page frozen on screen until the new page's queries
// finish, which reads as "the app is slow". This file is the route-group's
// Suspense fallback — it paints immediately on click (the sidebar/header stay
// put), and the real content streams in when its data is ready. Pure UI, no data
// fetching, so it can never add to the connection pressure the nav was tuned for.
export default function AppLoading() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {/* Page header */}
      <div className="mb-6">
        <div className="h-7 w-56 max-w-full rounded bg-slate-200" />
        <div className="mt-2 h-4 w-96 max-w-full rounded bg-slate-100" />
      </div>

      {/* Stat-card row (present on many pages) */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="h-3 w-20 rounded bg-slate-100" />
            <div className="mt-3 h-6 w-16 rounded bg-slate-200" />
          </div>
        ))}
      </div>

      {/* Table / list card */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-3">
          <div className="h-4 w-40 rounded bg-slate-200" />
        </div>
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3">
              <div className="h-4 w-1/4 rounded bg-slate-200" />
              <div className="hidden h-4 w-1/6 rounded bg-slate-100 sm:block" />
              <div className="hidden h-4 w-1/6 rounded bg-slate-100 md:block" />
              <div className="ml-auto h-4 w-16 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
