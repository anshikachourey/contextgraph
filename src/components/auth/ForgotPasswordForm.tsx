"use client";

import { useState, type FormEvent } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { VStack } from "@astryxdesign/core/VStack";
import { AuthShell } from "./AuthShell";
import { createBrowserSupabaseClient } from "@/src/lib/supabase/browser";
import { requestPasswordReset } from "@/src/lib/auth/actions";

/**
 * Forgot-password screen (Task 8.4, Req 20.2) — requests a reset email via
 * Supabase. The confirmation is NON-ENUMERATING: regardless of whether an
 * account exists (or whether Supabase errored), we show the SAME success
 * message so account existence cannot be inferred (Req 16.2, 16.3).
 */
export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    const supabase = createBrowserSupabaseClient();
    // The handler always resolves ok:true (non-enumerating by construction).
    await requestPasswordReset(supabase, email);
    setIsLoading(false);
    setSent(true);
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="If an account exists for that address, we've sent a reset link."
        footer={
          <Button variant="ghost" label="Back to sign in" href="/login" width="100%" />
        }
      >
        <Banner
          status="info"
          collapsible={false}
          title="Reset link sent"
          description="Follow the link in the email to choose a new password."
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
      footer={
        <Button variant="ghost" label="Back to sign in" href="/login" width="100%" />
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
          <Button
            type="submit"
            variant="primary"
            label={isLoading ? "Sending…" : "Send reset link"}
            isLoading={isLoading}
            isDisabled={isLoading}
            width="100%"
          />
        </VStack>
      </form>
    </AuthShell>
  );
}
