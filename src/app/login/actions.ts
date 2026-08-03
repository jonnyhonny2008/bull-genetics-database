"use server";

import { login } from "@/lib/auth";

export interface LoginState {
  error?: string;
  ok?: boolean;
}

/**
 * Signs the user in and REPORTS success rather than redirecting.
 *
 * `login()` sets the session cookie, so the browser is authenticated the moment
 * this returns. Navigation is left to the client so the login screen can play
 * its exit animation first; a server-side redirect() would cut it off mid-frame.
 */
export async function loginAction(_prev: unknown, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };
  const result = await login(email, password);
  if (result === "throttled") return { error: "Too many attempts. Please wait a minute and try again." };
  if (result === "invalid") return { error: "Invalid credentials, or account is inactive." };
  return { ok: true };
}
