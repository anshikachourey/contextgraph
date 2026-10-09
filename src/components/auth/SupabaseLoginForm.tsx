"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { AuthShell } from "./AuthShell";
import { createBrowserSupabaseClient } from "@/src/lib/supabase/browser";
import { startGoogleSignIn, signInWithEmail } from "@/src/lib/auth/actions";

/**
 * New Supabase login screen (Task 8.4, Req 20.1).
 *
 * Supports BOTH Google sign-in and email/password login, delegating entirely to
 * Supabase via the action handlers. On an invalid credential the handler returns
 * a GENERIC error (Req 15.3). Rendered ONLY when the cutover flag is enabled;
 * while the flag is false the legacy credential form renders instead so today's
 * behavior is unchanged.
 */
export default function SupabaseLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleGoogle() {
    setError(null);
    setIsLoading(true);
    const supabase = createBrowserSupabaseClient();
    const result = await startGoogleSignIn(supabase);
    if (!result.ok) {
      setError(result.error ?? "Sign-in failed.");
      setIsLoading(false);
    }
    // On success the browser is redirected to Google by the Supabase client.
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    const supabase = createBrowserSupabaseClient();
    const result = await signInWithEmail(supabase, email, password);
    if (!result.ok) {
      setError(result.error ?? "Sign-in failed.");
      setIsLoading(false);
      return;
    }
    router.replace("/");
  }

  return (
    <AuthShell
      title="Sign in to ContextGraph"
      subtitle="Turn conversations into connected knowledge."
      footer={
        <>
          <Button
            variant="ghost"
            label="Forgot your password?"
            href="/forgot-password"
            width="100%"
          />
          <Text type="supporting" justify="center">
            New to ContextGraph?
          </Text>
          <Button
            variant="secondary"
            label="Create an account"
            href="/signup"
            width="100%"
          />
        </>
      }
    >
      <VStack gap={4}>
        <Button
          variant="secondary"
          label="Continue with Google"
          width="100%"
          isDisabled={isLoading}
          clickAction={handleGoogle}
        />

        <Divider label="or" />

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
              placeholder="Enter password"
              htmlName="password"
              width="100%"
            />

            {error ? (
              <Banner status="error" collapsible={false} title={error} />
            ) : null}

            <Button
              type="submit"
              variant="primary"
              label={isLoading ? "Signing in…" : "Sign in"}
              isLoading={isLoading}
              isDisabled={isLoading}
              width="100%"
            />
          </VStack>
        </form>
      </VStack>
    </AuthShell>
  );
}
