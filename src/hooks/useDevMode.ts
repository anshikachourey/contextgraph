"use client";

import { useState, useEffect } from "react";

const STORAGE_KEY = "contextgraph_dev_mode";

/**
 * Developer mode hook.
 *
 * Returns true when dev mode is active. Dev mode is enabled by:
 * 1. NEXT_PUBLIC_DEV_MODE=true in .env.local (build-time)
 * 2. Ctrl+Shift+D (or Cmd+Shift+D) keyboard shortcut (runtime toggle)
 *
 * Dev mode shows Structure/Evolve debug buttons in the toolbar.
 * These are hidden in normal product usage.
 */
export function useDevMode(): boolean {
  const envEnabled = process.env.NEXT_PUBLIC_DEV_MODE === "true";

  const [runtimeEnabled, setRuntimeEnabled] = useState(false);

  useEffect(() => {
    // Load from localStorage
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setRuntimeEnabled(true);

    // Keyboard shortcut: Ctrl+Shift+D (or Cmd+Shift+D on Mac)
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setRuntimeEnabled((prev) => {
          const next = !prev;
          localStorage.setItem(STORAGE_KEY, String(next));
          return next;
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return envEnabled || runtimeEnabled;
}
