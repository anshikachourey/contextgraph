"use client";

import { useState, type FormEvent } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { VStack } from "@astryxdesign/core/VStack";
import { AuthShell } from "./AuthShell";
import { createBrowserSupabaseClient } from "@/src/lib/supabase/browser";
import { updatePassword, passwordActionLabel } from "@/src/lib/auth/actions";

/**
 * Shared set/change/reset-password screen (Task 8.4, Req 17.2, 18, 20.2).
 *
 * All three cases call the SAME Supabase `updateUser({ password })` under the
 * hood (via the action handler). The visible label switches per the
 * change-vs-set branch (Req 18.1/18.2):
 *
 *   - `/reset-password` (recovery session): label "Set new password".
 *   - `/set-password` for a Google user with no password: "Set Password".
 *   - `/set-password` for a user who already has a password: "Change Password".
 *
 * On failure we report an error and do NOT claim the credential changed
 * (Req 18.4).
 */
export default function PasswordForm({
  mode,
  hasPassword = true,
  recoveryError = false,
}: {
  /** "reset" after a recovery link; "manage" for authenticated set/change. */
  mode: "reset" | "manage";
  /** For "manage": whether the account already has a password (Req 18.1/18.2). */
  hasPassword?: boolean;
  /** For "reset": the recovery callback failed (Req 17.4). */
  recoveryError?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(
    recoveryError
      ? "This reset link is invalid or has expired. Request a new one."
      : null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [done, setDone] = useState(false);

  const actionLabel =
    mode === "reset" ? "Set new password" : passwordActionLabel(hasPassword);
  const title =
    mode === "reset" ? "Choose a new password" : passwordActionLabel(hasPassword);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length === 0) {
      setError("Please enter a password.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setIsLoading(true);
    const supabase = createBrowserSupabaseClient();
    const result = await updatePassword(supabase, password);
    setIsLoading(false);
    if (!result.ok) {
      setError(result.error ?? "We couldn't update your password.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        subtitle="Your password has been saved."
        footer={<Button variant="primary" label="Continue to app" href="/" width="100%" />}
      >
        <Banner status="success" collapsible={false} title="All set" />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={title}
      subtitle="Enter and confirm your new password."
      footer={
        mode === "reset" ? (
          <Button variant="ghost" label="Back to sign in" href="/login" width="100%" />
        ) : undefined
      }
    >
      <form onSubmit={handleSubmit}>
        <VStack gap={4}>
          <TextInput
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Enter a new password"
            htmlName="new-password"
            width="100%"
          />
          <TextInput
            label="Confirm password"
            type="password"
            value={confirm}
            onChange={setConfirm}
            placeholder="Re-enter the password"
            htmlName="confirm-password"
            width="100%"
          />

          {error ? (
            <Banner status="error" collapsible={false} title={error} />
          ) : null}

          <Button
            type="submit"
            variant="primary"
            label={isLoading ? "Saving…" : actionLabel}
            isLoading={isLoading}
            isDisabled={isLoading}
            width="100%"
          />
        </VStack>
      </form>
    </AuthShell>
  );
}
