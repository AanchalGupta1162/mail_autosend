"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { applyTheme, readPref, resolve, storePref, type ThemePref } from "@/lib/theme";

type Ctx = { pref: ThemePref; resolved: "light" | "dark"; setPref: (p: ThemePref) => void };

const ThemeCtx = createContext<Ctx>({ pref: "system", resolved: "light", setPref: () => {} });
export const useTheme = () => useContext(ThemeCtx);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  useEffect(() => {
    const initial = readPref();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setPrefState(initial);
    setResolved(resolve(initial));
  }, []);

  // Follow the OS while the preference is "system".
  useEffect(() => {
    if (pref !== "system") return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = () => {
      applyTheme("system");
      setResolved(resolve("system"));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    storePref(p);
    applyTheme(p);
    setPrefState(p);
    setResolved(resolve(p));
  }, []);

  return <ThemeCtx.Provider value={{ pref, resolved, setPref }}>{children}</ThemeCtx.Provider>;
}
