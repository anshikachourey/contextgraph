"use client";

import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "system" | "light" | "dark";

export const STORAGE_KEY = "contextgraph-theme";
/** Fired on the window whenever the theme mode changes within the same tab. */
export const THEME_CHANGE_EVENT = "contextgraph-theme-change";

function getSystemPreference(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(mode: ThemeMode) {
  const resolved = mode === "system" ? getSystemPreference() : mode;
  const html = document.documentElement;
  if (resolved === "dark") {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

/**
 * Hook to manage the app's color theme (system, light, dark).
 * Persists the choice to localStorage and applies the correct class to <html>.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(STORAGE_KEY) as ThemeMode) || "system";
  });

  // Apply theme on mount and when mode changes
  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    if (mode !== "system") return;

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    function handleChange() {
      applyTheme("system");
    }
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [mode]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
    applyTheme(newMode);
    // Notify same-tab listeners (e.g. the Astryx <Theme> provider bridge) so
    // the design-system mode stays in sync with the app's `.dark` class.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: newMode }),
      );
    }
  }, []);

  const resolvedTheme: "light" | "dark" =
    mode === "system" ? getSystemPreference() : mode;

  return { mode, setMode, resolvedTheme };
}
