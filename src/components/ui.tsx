import Link from "next/link";
import React from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <div className="accent-bar mt-2" />
        {subtitle && <div className="mt-2 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  children,
  className = "",
  actions,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className={`card ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          {actions}
        </div>
      )}
      <div className="card-pad">{children}</div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  href?: string;
  tone?: "default" | "warn" | "danger" | "good" | "accent";
}) {
  // Each tone pairs a value colour with a top accent stripe, so the warm tones
  // (warn / danger / accent) read as "pay attention" at a glance across the grid.
  const tones: Record<string, { text: string; bar: string }> = {
    default: { text: "text-slate-900", bar: "bg-brand-500" },
    warn: { text: "text-amber-600", bar: "bg-amber-400" },
    danger: { text: "text-red-600", bar: "bg-red-500" },
    good: { text: "text-brand-700", bar: "bg-brand-500" },
    accent: { text: "text-accent-600", bar: "bg-accent-500" },
  };
  const t = tones[tone] ?? tones.default;
  const inner = (
    <div className="card h-full overflow-hidden">
      <div className={`h-1 w-full ${t.bar}`} />
      <div className="card-pad">
        {/* text-[11px] + leading-tight + break-words keeps long labels (e.g.
            "Possible duplicates") tidy inside the narrow 6-across dashboard tiles
            instead of overflowing the card. */}
        <div className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-slate-500 break-words">{label}</div>
        <div className={`mt-1 text-3xl font-bold ${t.text}`}>{value}</div>
        {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition hover:-translate-y-0.5">
      {inner}
    </Link>
  ) : (
    inner
  );
}

const badgeTones: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  purple: "bg-purple-100 text-purple-800",
  brand: "bg-brand-100 text-brand-800",
  orange: "bg-accent-100 text-accent-800",
};

export function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: keyof typeof badgeTones }) {
  return <span className={`badge ${badgeTones[tone]}`}>{children}</span>;
}

export function statusTone(status?: string | null): keyof typeof badgeTones {
  switch (status) {
    case "approved":
      return "green";
    case "pending":
      return "amber";
    case "rejected":
      return "red";
    case "duplicate":
      return "purple";
    case "conflict_review":
      return "red";
    case "needs_more_info":
      return "blue";
    default:
      return "slate";
  }
}

export function EmptyState({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
      <div>{message}</div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function Table({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
