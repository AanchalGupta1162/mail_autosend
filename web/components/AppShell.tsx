"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";

type Mode = { dryRun: boolean; followupsHeld: boolean } | null;
type ModeContext = { mode: Mode; refreshMode: () => void; setMode: (m: Mode) => void };

const Ctx = createContext<ModeContext>({ mode: null, refreshMode: () => {}, setMode: () => {} });
export const useMode = () => useContext(Ctx);

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload", label: "Upload" },
  { href: "/contacts", label: "Contacts" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setMode] = useState<Mode>(null);
  const [signingOut, setSigningOut] = useState(false);

  const refreshMode = useCallback(() => {
    api
      .getDashboard()
      .then((d) => setMode({ dryRun: d.dryRun, followupsHeld: d.followupsHeld }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshMode();
  }, [refreshMode]);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      // Full navigation on purpose: drops the client router cache and all in-memory data.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }

  return (
    <Ctx.Provider value={{ mode, refreshMode, setMode }}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {mode?.dryRun && (
        <div className="dryrun-banner" role="status">
          <span className="dryrun-label">Dry run</span>
          <span>Emails are built and logged but never delivered. Set DRY_RUN=false on the server to send for real.</span>
        </div>
      )}
      <div className="shell">
        <header className="sidebar">
          <Link href="/dashboard" className="wordmark">
            Outbox
          </Link>
          <nav aria-label="Main">
            <ul className="nav">
              {NAV.map((n) => {
                const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
                return (
                  <li key={n.href}>
                    <Link href={n.href} className="nav-link" aria-current={active ? "page" : undefined}>
                      {n.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="sidebar-foot">
            {mode && (
              <span className={`mode-chip ${mode.dryRun ? "mode-dry" : "mode-live"}`}>{mode.dryRun ? "Dry run" : "Live sending"}</span>
            )}
            <button type="button" className="btn btn-quiet btn-small" onClick={signOut} disabled={signingOut}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {mode?.followupsHeld && (
            <div className="callout callout-warning held-banner" role="status">
              <p className="callout-title">Follow-ups are on hold</p>
              <p>
                Reply checking hasn&apos;t succeeded in the last hour, so no follow-up goes out until it does. First emails still send.{" "}
                <Link href="/dashboard#replies">See reply checks</Link>
              </p>
            </div>
          )}
          {children}
        </main>
      </div>
    </Ctx.Provider>
  );
}
