"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FlaskConical, LayoutDashboard, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Settings, Upload, Users, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Notice } from "./Notice";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Mode = { dryRun: boolean; followupsHeld: boolean } | null;
type ModeContext = { mode: Mode; refreshMode: () => void; setMode: (m: Mode) => void };

const Ctx = createContext<ModeContext>({ mode: null, refreshMode: () => {}, setMode: () => {} });
export const useMode = () => useContext(Ctx);

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

const COLLAPSE_KEY = "outbox-sidebar-collapsed";

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function NavList({ pathname, collapsed = false, onNavigate }: { pathname: string; collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          const link = (
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-accent hover:text-foreground",
                "aria-[current=page]:bg-accent aria-[current=page]:text-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", active && "text-accent-text")} />
              {!collapsed && label}
            </Link>
          );
          return (
            <li key={href}>
              {collapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{label}</TooltipContent>
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ModeChip({ mode, failed }: { mode: Mode; failed: boolean }) {
  const base = "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium whitespace-nowrap";
  if (mode) {
    return (
      <span data-slot="mode-chip" className={cn(base, mode.dryRun ? "bg-st-amber-bg text-st-amber" : "bg-st-green-bg text-st-green")}>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        {mode.dryRun ? "Dry run" : "Live sending"}
      </span>
    );
  }
  if (failed) {
    return (
      <span data-slot="mode-chip" className={cn(base, "bg-st-red-bg text-st-red")} title="Could not load the server's sending mode. Treat it as live until the dashboard loads.">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        Mode unknown
      </span>
    );
  }
  return null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setModeState] = useState<Mode>(null);
  const [modeFailed, setModeFailed] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    if (m) setModeFailed(false);
  }, []);
  const [signingOut, setSigningOut] = useState(false);

  const refreshMode = useCallback(() => {
    api
      .getDashboard()
      .then((d) => setMode({ dryRun: d.dryRun, followupsHeld: d.followupsHeld }))
      .catch(() => setModeFailed(true));
  }, [setMode]);

  useEffect(() => {
    refreshMode();
    api.me().then(
      (u) => setUsername(typeof u?.username === "string" ? u.username : null),
      () => {},
    );
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // Storage blocked: the sidebar just starts expanded.
    }
  }, [refreshMode]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // ignore
      }
      return !c;
    });
  }

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

  const current = NAV.find((n) => isActive(pathname, n.href));
  const initial = (username ?? "?").slice(0, 1).toUpperCase();

  return (
    <Ctx.Provider value={{ mode, refreshMode, setMode }}>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
        href="#main"
      >
        Skip to content
      </a>

      <div className="flex min-h-svh">
        <aside
          className={cn(
            "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:flex",
            collapsed ? "w-14" : "w-56",
          )}
        >
          <div className={cn("flex h-12 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
            <Link href="/dashboard" className="flex items-center gap-2 rounded-md" aria-label="Outbox">
              <BrandMark />
              {!collapsed && <span className="text-sm font-semibold tracking-tight">Outbox</span>}
            </Link>
          </div>
          <div className={cn("flex-1 overflow-y-auto px-2 py-2", collapsed && "px-1.5")}>
            <NavList pathname={pathname} collapsed={collapsed} />
          </div>
          <div className={cn("flex border-t border-sidebar-border p-2", collapsed && "justify-center")}>
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-pressed={collapsed}
              className="text-muted-foreground"
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              {!collapsed && "Collapse"}
            </Button>
          </div>
        </aside>

        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="w-64 gap-0 border-r bg-sidebar p-0" aria-describedby="nav-desc">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription id="nav-desc" className="sr-only">
              Navigate between pages
            </SheetDescription>
            <div className="flex h-12 items-center gap-2 px-4">
              <BrandMark />
              <span className="text-sm font-semibold tracking-tight">Outbox</span>
            </div>
            <div className="px-2 py-2">
              <NavList pathname={pathname} onNavigate={() => setNavOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {mode?.dryRun && (
            <div role="status" className="flex items-center gap-2 border-b border-st-amber/25 bg-st-amber-bg px-4 py-1.5 text-xs text-foreground">
              <FlaskConical aria-hidden="true" className="size-3.5 shrink-0 text-st-amber" />
              <span>
                <strong className="font-medium text-st-amber">Dry run.</strong> Emails are built and logged but never delivered. Set DRY_RUN=false on the server to send for real.
              </span>
            </div>
          )}
          <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-5">
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setNavOpen(true)}>
              <Menu />
            </Button>
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{current?.label ?? "Outbox"}</p>
            <ModeChip mode={mode} failed={modeFailed} />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
                  <Avatar className="size-6">
                    <AvatarFallback className="bg-accent text-[11px] font-medium">{initial}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {username && (
                  <>
                    <DropdownMenuLabel className="font-normal">
                      <span className="block text-xs text-muted-foreground">Signed in as</span>
                      <span className="block truncate font-medium">{username}</span>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={signingOut} onSelect={signOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none md:px-8 md:py-8">
            {mode?.followupsHeld && (
              <Notice tone="warning" title="Follow-ups are on hold" role="status" className="mb-6">
                <p>
                  Reply checking hasn&apos;t succeeded in the last hour, so no follow-up goes out until it does. First emails still send.{" "}
                  <Link href="/dashboard#replies" className="font-medium underline underline-offset-2">
                    See reply checks
                  </Link>
                </p>
              </Notice>
            )}
            {children}
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
