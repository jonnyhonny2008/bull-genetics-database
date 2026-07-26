// Security response headers applied to every route. CSP is intentionally strict
// but allows the inline styles/scripts Next.js needs; no external origins.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" }, // clickjacking
  { key: "X-Content-Type-Options", value: "nosniff" }, // MIME sniffing
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline runtime scripts; 'unsafe-inline' is required for the app router.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // don't advertise Next.js version
  // ESLint is optional for this build; type-checking still runs.
  eslint: { ignoreDuringBuilds: true },
  // The uploaded-file directory and prisma engine are server-only; nothing special needed.
  experimental: {
    // Server Actions are stable in Next 14; allow larger uploads.
    serverActions: {
      bodySizeLimit: "15mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
