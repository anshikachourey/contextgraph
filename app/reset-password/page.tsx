import PasswordForm from "@/src/components/auth/PasswordForm";

/**
 * /reset-password — set a new password within a recovery session (Task 8.4,
 * Req 17.2, 20.2). Reached after `/auth/confirm?type=recovery` establishes the
 * Recovery_Session. If the recovery callback failed, `?error=recovery` surfaces
 * a generic error (Req 17.4).
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <PasswordForm mode="reset" recoveryError={error === "recovery"} />;
}
