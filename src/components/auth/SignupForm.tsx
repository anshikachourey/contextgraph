"use client";

import { useState, type FormEvent } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { VStack } from "@astryxdesign/core/VStack";
import { AuthShell } from "./AuthShell";
import { createBrowserSupabaseClient } from "@/src/lib/supabase/browser";
import { signUpWithEmail } from "@/src/lib/auth/actions";

/**
 * Signup screen (Task 8.4, Req 20.2) — email/password signup delegated to
 * Supabase. On success with verification required, we show a "check your email"
 * confirmation (Req 14.3). A failed verification-email send is surfaced via the
 * action handler's message (Req 14.6).
 */
export default function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    const supabase = createBrowserSupabaseClient();
    const result = await signUpWithEmail(supabase, email, password);
    setIsLoading(false);
    if (!result.ok) {
      setError(result.error ?? "Signup failed.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="We sent a verification link to confirm your account."
        footer={
          <Button variant="ghost" label="Back to sign in" href="/login" width="100%" />
        }
      >
        <Banner
          status="success"
          collapsible={false}
          title="Verification email sent"
          description="Open the link in your inbox to finish creating your account."
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Sign up with your email and a password."
      footer={
        <Button variant="ghost" label="Already have an account? Sign in" href="/login" width="100%" />
      }
    >
      <form onSubmit={handleSubmit}>
        <VStack gap={4}>
          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            htmlName="email"
            width="100%"
          />
          <TextInput
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Create a password"
            htmlName="password"
            width="100%"
          />

          {error ? (
            <Banner status="error" collapsible={false} title={error} />
          ) : null}

          <Button
            type="submit"
            variant="primary"
            label={isLoading ? "Creating account…" : "Create account"}
            isLoading={isLoading}
            isDisabled={isLoading}
            width="100%"
          />
        </VStack>
      </form>
    </AuthShell>
  );
}
