import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { AuthShell } from "./AuthShell";

/**
 * Email-verification result screen (Task 8.4, Req 20.3).
 *
 * Presents the outcome of the `/auth/confirm` signup verification. On error the
 * message is GENERIC — it never reveals token state (Req 14.4).
 */
export default function VerifyEmailResult({
  status,
}: {
  status: "success" | "error" | "pending";
}) {
  if (status === "error") {
    return (
      <AuthShell
        title="Verification failed"
        subtitle="This verification link is invalid or has expired."
        footer={<Button variant="primary" label="Back to sign in" href="/login" width="100%" />}
      >
        <Banner
          status="error"
          collapsible={false}
          title="We couldn't verify your email"
          description="Request a new link by signing up or signing in again."
        />
      </AuthShell>
    );
  }

  if (status === "success") {
    return (
      <AuthShell
        title="Email verified"
        subtitle="Your account is confirmed."
        footer={<Button variant="primary" label="Continue to app" href="/" width="100%" />}
      >
        <Banner status="success" collapsible={false} title="You're all set" />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Check your email"
      subtitle="Open the verification link we sent to confirm your account."
      footer={<Button variant="ghost" label="Back to sign in" href="/login" width="100%" />}
    >
      <Banner status="info" collapsible={false} title="Verification pending" />
    </AuthShell>
  );
}
