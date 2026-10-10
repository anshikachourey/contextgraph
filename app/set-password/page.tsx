import PasswordForm from "@/src/components/auth/PasswordForm";
import { createUserScopedClient } from "@/src/lib/supabase/server";

/**
 * /set-password — authenticated set-or-change password (Task 8.4, Req 18, 20.2).
 *
 * The label switches to "Set Password" for a Google user with NO password
 * identity, and "Change Password" otherwise (Req 18.2). We detect this
 * server-side by inspecting the user's linked identities: a user with an
 * `email` provider identity already has a password credential; one with only
 * `google` does not.
 */
export default async function SetPasswordPage() {
  const hasPassword = await userHasPasswordIdentity();
  return <PasswordForm mode="manage" hasPassword={hasPassword} />;
}

/**
 * Returns true iff the current user has an email/password credential. Derived
 * from Supabase identities (never from a JWT role claim). Falls back to treating
 * the account as "has password" (→ "Change Password") if identities cannot be
 * read, which is the safe, non-misleading default.
 */
async function userHasPasswordIdentity(): Promise<boolean> {
  try {
    const supabase = await createUserScopedClient();
    const { data } = await supabase.auth.getUser();
    const identities = data?.user?.identities ?? [];
    return identities.some((i) => i.provider === "email");
  } catch {
    return true;
  }
}
