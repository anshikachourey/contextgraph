"use client";

import { useEffect, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import {
  STORAGE_KEY,
  THEME_CHANGE_EVENT,
  type ThemeMode,
} from "@/src/hooks/useTheme";

/**
 * Wraps the app in the Astryx <Theme> provider so migrated design-system
 * components read the active theme tokens.
 *
 * The color mode is kept in sync with the existing `useTheme` hook (which owns
 * the `.dark` class on <html> for non-migrated UI) by reading the same
 * localStorage key and listening for:
 *   - the same-tab custom event dispatched by useTheme.setMode
 *   - cross-tab `storage` events
 *
 * This preserves the existing theme-preference, localStorage, and no-flash
 * behavior; Astryx mode simply mirrors it.
 */
function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  return (localStorage.getItem(STORAGE_KEY) as ThemeMode) || "system";
}

export default function AstryxThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Lazy initializer reads the stored preference. On the server this returns
  // "system"; the inline no-flash script in layout.tsx already sets the `.dark`
  // class before paint, so there is no visual flash.
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    // Subscribe to theme changes. setState only runs in response to an external
    // event (same-tab custom event or cross-tab storage), not synchronously in
    // the effect body.
    function handleCustom(e: Event) {
      const detail = (e as CustomEvent<ThemeMode>).detail;
      setMode(detail ?? readStoredMode());
    }
    function handleStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setMode(readStoredMode());
    }

    window.addEventListener(THEME_CHANGE_EVENT, handleCustom);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, handleCustom);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return (
    <Theme theme={neutralTheme} mode={mode}>
      {children}
    </Theme>
  );
}
