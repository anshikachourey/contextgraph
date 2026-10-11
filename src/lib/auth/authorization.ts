/**
 * Server-only authorization helpers for workspace-scoped data access.
 *
 * These enforce that:
 * 1. A valid session exists (fail → 401)
 * 2. The requested resource belongs to the caller's workspace (fail → 404)
 *
 * Never import this file from client components.
 */

import { NextResponse } from "next/server";
import {
  getSession,
  getAuthClaims,
  type SessionPayload,
  type Workspace,
  type AuthClaims,
} from "./session";
import { createUserScopedClient } from "@/src/lib/supabase/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/legacy-service-role";
import { isSupabaseCutoverEnabled } from "@/src/lib/config/cutover";

type AuthError = NextResponse<{ error: string }>;

/**
 * Require a valid session. Returns the session payload or a 401 JSON response.
 */
export async function requireSession(): Promise<SessionPayload | AuthError> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return session;
}

/**
 * Verify that a conversation belongs to the caller's workspace.
 * Returns the workspace or a 404 JSON response.
 *
 * Cross-workspace requests return 404 (not 403) to avoid leaking existence.
 */
export async function requireConversationAccess(
  conversationId: string,
  session: SessionPayload,
): Promise<Workspace | AuthError> {
  // ─── Flag ENABLED: membership-based access via RLS (Req 7.4, 10.1) ─────────
  // The user-scoped client only ever sees rows in workspaces the caller is a
  // member of, so a non-member's lookup returns ZERO ROWS, which we translate
  // to the existing cross-workspace 404. No manual workspace_id string check.
  if (isSupabaseCutoverEnabled()) {
    const db = await createUserScopedClient();
    const { data, error } = await db
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return session.workspace;
  }

  // ─── Flag DISABLED (default today): LEGACY manual workspace_id check ────────
  // Behavior-neutral — identical to the pre-feature implementation.
  const db = createServerSupabaseClient();

  const { data, error } = await db
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (data.workspace_id !== session.workspace) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return session.workspace;
}

/**
 * Helper type guard: checks if the result is an error response.
 */
export function isAuthError(
  result: SessionPayload | Workspace | AuthClaims | AuthError,
): result is AuthError {
  return result instanceof NextResponse;
}

// ─── Supabase membership authorization (Req 6, 7, 10) ─────────────────────────

/**
 * The three provisioning tables that must exist for the caller before any
 * usable access is granted (Req 6.4).
 */
const PROVISIONING_UNPROVISIONED_ERROR = NextResponse.json(
  { error: "Account provisioning incomplete." },
  { status: 403, headers: { "Cache-Control": "no-store" } },
) as AuthError;

/**
 * Require an authenticated Supabase user.
 *
 * Reads identity-only claims via `getClaims()` (never the Google subject),
 * returns 401 when there is no valid session, then runs the provisioning gate.
 * Returns the resolved {@link AuthClaims} on success.
 *
 * GATING: this is only reachable on the user-scoped path once
 * `AUTH_SUPABASE_CUTOVER_ENABLED` is true. While the flag is false the legacy
 * `requireSession()` remains the active entry point for current routes, so
 * runtime behavior is unchanged. `requireUser()` fail-closes (401) if invoked
 * while the flag is disabled, so it can never silently accept a Supabase
 * session before cutover.
 *
 * Requirements: 4.x, 6.4, 6.5, 6.6, 7.2
 */
export async function requireUser(): Promise<AuthClaims | AuthError> {
  if (!isSupabaseCutoverEnabled()) {
    // Pre-cutover: the Supabase identity path is not accepted for access.
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const client = await createUserScopedClient();
  const claims = await getAuthClaims(client);
  if (!claims) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const provisioned = await ensureProvisioned();
  if (provisioned !== null) return provisioned;

  return claims;
}

/**
 * Provisioning gate (Req 6.4, 6.5). Runs ENTIRELY under the user-scoped client
 * bound to `auth.uid()` — NEVER the service-role client (Req 6, 10, 12).
 *
 * 1. Verify the caller's three rows exist (profile, personal workspace,
 *    membership) via the user-scoped client (RLS-visible to the caller).
 * 2. If any is missing, call the `auth.uid()`-bound `provision_self()` RPC
 *    (idempotent `ON CONFLICT DO NOTHING`) and re-verify.
 * 3. Deny access until all three are confirmed committed.
 *
 * Returns `null` when fully provisioned (access allowed), or a denial response.
 */
export async function ensureProvisioned(): Promise<AuthError | null> {
  const client = await createUserScopedClient();

  const confirmed = await hasAllThreeProvisioningRows(client);
  if (confirmed) return null;

  // Fallback: trigger the auth.uid()-bound RPC, then re-verify. No uid param,
  // no service-role.
  const { error: rpcError } = await client.rpc("provision_self");
  if (rpcError) return PROVISIONING_UNPROVISIONED_ERROR;

  const reconfirmed = await hasAllThreeProvisioningRows(client);
  return reconfirmed ? null : PROVISIONING_UNPROVISIONED_ERROR;
}

/**
 * Reads whether the caller currently has all three provisioning rows, using the
 * user-scoped client so RLS only ever exposes the caller's own rows. A profile
 * row the caller can see, a personal account workspace they own, and a
 * membership in it together satisfy the gate (Req 6.4).
 */
async function hasAllThreeProvisioningRows(
  client: Awaited<ReturnType<typeof createUserScopedClient>>,
): Promise<boolean> {
  const [profile, workspace, membership] = await Promise.all([
    client.from("user_profiles").select("id").limit(1),
    client
      .from("account_workspaces")
      .select("id")
      .eq("kind", "personal")
      .limit(1),
    client.from("workspace_memberships").select("id").limit(1),
  ]);

  const ok = (res: { data: unknown[] | null; error: unknown }) =>
    !res.error && Array.isArray(res.data) && res.data.length > 0;

  return ok(profile as any) && ok(workspace as any) && ok(membership as any);
}
