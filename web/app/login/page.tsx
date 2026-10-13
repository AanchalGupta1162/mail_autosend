import type { Metadata } from "next";
import { BrandMark } from "@/components/BrandMark";
import { LoginForm } from "@/components/LoginForm";
import { safeNext } from "@/lib/guard";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <main className="relative grid min-h-svh place-items-center px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-border" />
      <div className="w-full max-w-[22rem]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-10 rounded-xl [&_svg]:size-5" />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Sign in to Outbox</h1>
            <p className="text-[13px] text-muted-foreground">Schedule your outreach and track the replies.</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)]">
          <LoginForm next={safeNext(typeof next === "string" ? next : null)} />
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">Private workspace. Sessions end when you sign out.</p>
      </div>
    </main>
  );
}
