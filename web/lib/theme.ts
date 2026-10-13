// Theme preference: "light" | "dark" | "system", kept in localStorage (never required to work).

export type ThemePref = "light" | "dark" | "system";
export const THEME_KEY = "outbox-theme";

export const isPref = (v: unknown): v is ThemePref => v === "light" || v === "dark" || v === "system";

export function readPref(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isPref(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function storePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Private mode or blocked storage: the choice just lasts for this page view.
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolve(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.classList.toggle("dark", resolve(pref) === "dark");
}

/** Runs before first paint (inline script carrying the CSP nonce) so there is no flash. */
export const themeInitScript = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");var d=p==="dark"||((p!=="light")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
