import SignupForm from "@/src/components/auth/SignupForm";

/**
 * /signup — email/password signup (Task 8.4, Req 20.2).
 *
 * Additive route. Reachable from the new Supabase login UI; it does not change
 * the legacy experience while `AUTH_SUPABASE_CUTOVER_ENABLED` is false.
 */
export default function SignupPage() {
  return <SignupForm />;
}
