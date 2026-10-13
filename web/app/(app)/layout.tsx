import { AppShell } from "@/components/AppShell";

// proxy.ts has already verified the session before this renders.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
