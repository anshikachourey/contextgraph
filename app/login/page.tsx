import { isSupabaseCutoverEnabled } from "@/src/lib/config/cutover";
import LegacyLoginForm from "@/src/components/auth/LegacyLoginForm";
import SupabaseLoginForm from "@/src/components/auth/SupabaseLoginForm";

/**
 * /login — flag-aware login screen (Task 8.4, Req 20.1).
 *
 * Feature: google-oauth-authentication
 *
 * FLAG-AWARE BEHAVIOR-NEUTRALITY (chosen approach):
 * This is now a SERVER component that reads the SERVER-ONLY cutover flag and
 * picks which login experience to render:
 *
 *   - `AUTH_SUPABASE_CUTOVER_ENABLED` false (default TODAY) → render the LEGACY
 *     owner/demo credential form, moved verbatim into `LegacyLoginForm`. The
 *     markup, the `/api/auth/login` POST, and every behavior are UNCHANGED, so
 *     there is zero behavior change while the flag is false.
 *
 *   - flag true (post-cutover) → render the new Supabase login UI (Google +
 *     email/password) built on Astryx components.
 *
 * Because the flag is server-only and evaluated here, the browser never sees the
 * other branch's code path. The new Supabase screens at `/signup`,
 * `/forgot-password`, `/reset-password`, `/set-password`, and `/verify-email`
 * are ADDITIVE routes; they exist regardless of the flag but are only reachable
 * from the new login UI, so they do not alter the legacy experience today.
 */
export default function LoginPage() {
  if (isSupabaseCutoverEnabled()) {
    return <SupabaseLoginForm />;
  }
  return <LegacyLoginForm />;
}
