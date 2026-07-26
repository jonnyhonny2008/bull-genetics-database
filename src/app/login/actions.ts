"use server";

import { login } from "@/lib/auth";
import { redirect } from "next/navigation";

export async function loginAction(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };
  const result = await login(email, password);
  if (result === "throttled") return { error: "Too many attempts. Please wait a minute and try again." };
  if (result === "invalid") return { error: "Invalid credentials, or account is inactive." };
  redirect("/dashboard");
}
