"use client";
import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";

// Pure: the concrete theme to apply given the preference and the OS setting.
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return systemPrefersDark ? "dark" : "light";
}

/**
 * The theme is the Captivo family's `captivo-theme` cookie, on `.captivo.io`
 * where the host is under it: Portal, Captivo ID and this console then show
 * the same choice. Without a choice the console is dark (the design's default).
 */
export const THEME_COOKIE = "captivo-theme";

export function themeCookieDomain(hostname: string): string | null {
  return hostname === "captivo.io" || hostname.endsWith(".captivo.io") ? ".captivo.io" : null;
}

const listeners = new Set<() => void>();
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function getSnapshot(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function getServerSnapshot(): "light" | "dark" {
  return "dark";
}

export function setTheme(t: "light" | "dark") {
  document.documentElement.dataset.theme = t;
  const domain = themeCookieDomain(location.hostname);
  document.cookie =
    `${THEME_COOKIE}=${t}; path=/; max-age=31536000; samesite=lax` +
    (domain ? `; domain=${domain}` : "") +
    (location.protocol === "https:" ? "; secure" : "");
  try {
    localStorage.removeItem("ca-theme"); // the old per-host setting, now the cookie
  } catch {
    /* storage blocked: the cookie is enough */
  }
  listeners.forEach((l) => l());
}

/** The theme in use, following every change made through setTheme. */
export function useTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** One button: the icon shows the theme it switches to. */
export function ThemeSwitcher() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {next === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
