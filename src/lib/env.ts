// Environment marker helpers. APP_ENV is set by .env.demo / .env.production.

export type AppEnv = "demo" | "production";

export function appEnv(): AppEnv {
  return process.env.APP_ENV === "production" ? "production" : "demo";
}

export function isProduction(): boolean {
  return appEnv() === "production";
}

export function isDemo(): boolean {
  return appEnv() === "demo";
}

export function envLabel(): string {
  return isProduction() ? "PRODUCTION ENVIRONMENT" : "DEMO ENVIRONMENT";
}

export function envBannerColor(): string {
  // amber for demo, red for production — instantly distinguishable.
  return isProduction()
    ? "bg-red-700 text-white"
    : "bg-amber-500 text-black";
}
