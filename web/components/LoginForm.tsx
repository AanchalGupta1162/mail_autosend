"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { safeNext } from "@/lib/guard";

// Fixed copy only: never echo server details (account existence, lock state, IPs).
function loginMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Sign-in failed. Try again.";
  switch (err.status) {
    case 0:
      return err.message;
    case 401:
      return "Invalid username or password.";
    case 429:
      return "Too many sign-in attempts. Wait 15 minutes, then try again.";
    case 403:
      return "Your sign-in form expired. Reload the page and try again.";
    default:
      return "Sign-in failed. Try again.";
  }
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      router.replace(safeNext(next));
    } catch (err) {
      setPassword("");
      setError(loginMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={onSubmit} noValidate aria-describedby={error ? "login-error" : undefined}>
      <div className="field">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>
      {error && (
        <p className="callout callout-danger" role="alert" id="login-error">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
