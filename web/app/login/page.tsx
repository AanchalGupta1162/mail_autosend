import type { Metadata } from "next";
import { LoginForm } from "@/components/LoginForm";
import { safeNext } from "@/lib/guard";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <main className="login">
      <div className="login-card">
        <div className="airmail-edge" aria-hidden="true" />
        <div className="login-inner">
          <p className="wordmark">Outbox</p>
          <h1 className="login-title">Sign in to schedule your outreach</h1>
          <LoginForm next={safeNext(typeof next === "string" ? next : null)} />
        </div>
      </div>
    </main>
  );
}
