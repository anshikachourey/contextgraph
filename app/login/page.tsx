"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Login failed.");
        return;
      }

      // Redirect to main app
      router.replace("/");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      {/* Subtle graph/network background motif — CSS only */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.06]"
        style={{
          backgroundImage: `
            radial-gradient(circle at 20% 30%, var(--accent) 1px, transparent 1px),
            radial-gradient(circle at 80% 20%, var(--accent) 1px, transparent 1px),
            radial-gradient(circle at 60% 70%, var(--accent) 1px, transparent 1px),
            radial-gradient(circle at 30% 80%, var(--accent) 1px, transparent 1px),
            radial-gradient(circle at 75% 55%, var(--accent) 1px, transparent 1px),
            radial-gradient(circle at 10% 60%, var(--accent) 0.5px, transparent 0.5px),
            radial-gradient(circle at 90% 85%, var(--accent) 0.5px, transparent 0.5px),
            radial-gradient(circle at 45% 15%, var(--accent) 0.5px, transparent 0.5px),
            linear-gradient(135deg, var(--accent) 0.5px, transparent 0.5px),
            linear-gradient(45deg, var(--accent) 0.3px, transparent 0.3px)
          `,
          backgroundSize: `
            100% 100%,
            100% 100%,
            100% 100%,
            100% 100%,
            100% 100%,
            100% 100%,
            100% 100%,
            100% 100%,
            80px 80px,
            120px 120px
          `,
        }}
      />

      {/* Soft gradient overlay */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at 50% 40%, var(--accent-light) 0%, transparent 60%)`,
          opacity: 0.4,
        }}
      />

      {/* Login card */}
      <div className="relative z-10 w-full max-w-[380px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-lg shadow-black/[0.04] dark:shadow-black/[0.2]">
        {/* Logo / brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          {/* Graph icon matching the Knowledge Graph button in the app */}
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-light)]">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="6" cy="6" r="3" />
              <circle cx="18" cy="18" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M6 9v6M9 6h6M15 18H9" />
            </svg>
          </div>

          <div className="text-center">
            <h1 className="text-[20px] font-semibold tracking-tight text-[var(--foreground)]">
              ContextGraph
            </h1>
            <p className="mt-1 text-[13px] text-[var(--muted-foreground)]">
              Turn conversations into connected knowledge.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Username */}
          <div>
            <label
              htmlFor="username"
              className="mb-1.5 block text-[13px] font-medium text-[var(--muted-foreground)]"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5 text-[14px] text-[var(--foreground)] outline-none transition-all duration-200 placeholder:text-[var(--muted-foreground)]/50 hover:border-[var(--muted-foreground)]/30 focus:border-[var(--accent)]/50 focus:ring-2 focus:ring-[var(--accent)]/15"
              placeholder="Enter username"
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-[13px] font-medium text-[var(--muted-foreground)]"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5 pr-10 text-[14px] text-[var(--foreground)] outline-none transition-all duration-200 placeholder:text-[var(--muted-foreground)]/50 hover:border-[var(--muted-foreground)]/30 focus:border-[var(--accent)]/50 focus:ring-2 focus:ring-[var(--accent)]/15"
                placeholder="Enter password"
              />
              {/* Password visibility toggle */}
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <path d="M14.12 14.12a3 3 0 11-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div
              className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-[13px] text-red-600 dark:bg-red-950/30 dark:text-red-400"
              role="alert"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className="mt-2 w-full rounded-xl bg-[var(--accent)] px-4 py-2.5 text-[14px] font-medium text-white shadow-sm transition-all duration-200 hover:bg-[var(--accent-hover)] hover:shadow-md active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-sm"
          >
            {isLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
