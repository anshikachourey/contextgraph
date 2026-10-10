import VerifyEmailResult from "@/src/components/auth/VerifyEmailResult";

/**
 * /verify-email — email-verification result screen (Task 8.4, Req 20.3).
 *
 * `/auth/confirm` redirects here with `?status=error` when a signup
 * verification token is invalid/expired. Without a status it shows a neutral
 * "check your email" pending state.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const resolved =
    status === "success" ? "success" : status === "error" ? "error" : "pending";
  return <VerifyEmailResult status={resolved} />;
}
