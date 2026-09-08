"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";

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
          <TextInput
            label="Username"
            value={username}
            onChange={setUsername}
            placeholder="Enter username"
            htmlName="username"
            width="100%"
          />

          {/* Password */}
          <div>
            <TextInput
              label="Password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={setPassword}
              placeholder="Enter password"
              htmlName="password"
              width="100%"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="mt-1.5 text-[12px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
              tabIndex={-1}
            >
              {showPassword ? "Hide password" : "Show password"}
            </button>
          </div>

          {/* Error */}
          {error && (
            <Banner status="error" collapsible={false} title={error} />
          )}

          {/* Submit */}
          <Button
            type="submit"
            variant="primary"
            label={isLoading ? "Signing in…" : "Sign in"}
            isLoading={isLoading}
            isDisabled={isLoading}
            width="100%"
          />
        </form>
      </div>
    </div>
  );
}
