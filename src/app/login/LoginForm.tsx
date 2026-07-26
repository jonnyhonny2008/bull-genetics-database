"use client";

import { useFormState, useFormStatus } from "react-dom";
import { loginAction } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm({ prefillEmail }: { prefillEmail?: string }) {
  const [state, formAction] = useFormState(loginAction, { error: undefined } as { error?: string });
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" defaultValue={prefillEmail} className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" className="input" required />
      </div>
      {state?.error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>}
      <SubmitButton />
    </form>
  );
}
