# Implementation Plan: Google OAuth Authentication

## Overview

This plan implements the migration from the legacy owner/demo HMAC login to Supabase Auth
(Google OAuth + PKCE and email/password) with membership-and-role authorization enforced by
Row Level Security. It follows the design's **Service-Role Migration & Cutover Plan** sequencing
exactly: additive scaffolding first (behavior-neutral, flag disabled), then schema/provisioning,
then a foundational refactor of shared DB helpers to accept a passed-in client, then the auth
plumbing, then route conversion in reviewable batches (each paired with its negative
cross-workspace test), then the `UUID_Migration`, and finally — as the strict last step — the
cutover flag flip and removal of the legacy login.

Implementation language is **TypeScript** (Next.js 16 App Router) with **SQL** migrations, as the
design specifies concretely. All npm/Vitest commands run under **Node 22**. Property-based tests
use `fast-check` under Vitest (min 100 runs each), tagged
`// Feature: google-oauth-authentication, Property N: ...`, against pure in-memory models.

Items that can only be validated against a live Supabase project are called out as **MANUAL-ONLY**
checkpoints and are intentionally not automated.

## Tasks

- [x] 1. Additive scaffolding (no behavior change; `AUTH_SUPABASE_CUTOVER_ENABLED` stays false)
  - [x] 1.1 Add `@supabase/ssr` dependency and the cutover flag
    - Add `@supabase/ssr` to `package.json` dependencies; install under Node 22
    - Add `AUTH_SUPABASE_CUTOVER_ENABLED` (server-side env, default `false`) to `.env.example` and a typed config accessor in `src/lib/config` (or equivalent) that reads it server-side only
    - Do not change any existing runtime behavior; `supabase-js` stays as-is
    - _Requirements: 5.1, 5.2, 5.3_
    - _Design: Architecture → Runtime context; Cutover gate (disabled feature flag)_

  - [x] 1.2 Create the browser and user-scoped server client factories
    - `src/lib/supabase/browser.ts` → `createBrowserSupabaseClient()` (`createBrowserClient`, anon key)
    - `src/lib/supabase/server.ts` → `createUserScopedClient()` (`createServerClient`, anon key, cookie handler bound to `next/headers` `cookies()` with tolerate-write `setAll`)
    - These are additive; existing service-role export is renamed in 1.3
    - _Requirements: 10.1, 12.3_
    - _Design: Components → 1. Supabase client factories_

  - [x] 1.3 Create the service-role factory with a conspicuous name, opt-in marker, and runtime hard-violation guard
    - `src/lib/supabase/service-role.ts` → `createServiceRoleClient({ allowServiceRole: true })` (`SUPABASE_SERVICE_ROLE_KEY`, server-only, `persistSession:false`)
    - Rename/move the current `createServerSupabaseClient` so the obvious server import becomes the user-scoped client; the service-role factory is deliberately conspicuous
    - Runtime hard-violation guard: throw unless called from an allowlisted module **with** the opt-in marker; never permit from middleware or page/route request paths
    - _Requirements: 10.3, 10.5, 12.1_
    - _Design: Components → 1 (Migration note); Service-role allowlist and CI static check (Runtime enforcement)_

  - [x]* 1.4 Write unit tests for the hard-violation guard
    - Guard throws when invoked from a request-marked / non-allowlisted context; succeeds only from an allowlisted module with `allowServiceRole: true`
    - _Requirements: 10.5_
    - _Design: Testing Strategy → Example/integration (Hard-violation guard)_

  - [x] 1.5 Add the service-role allowlist module (group (d) only — NOT provisioning)
    - `src/lib/supabase/service-role-allowlist.ts`: an array containing ONLY the `UUID_Migration` runner path and genuinely offline/system/background job paths (recovery trigger, bulk storage/system cleanup, calibration/maintenance)
    - Provisioning MUST NOT appear (it runs via the trigger / `provision_self()` RPC)
    - Referenced by both the runtime guard (1.3) and the CI static check (1.6)
    - _Requirements: 10.3, 10.5, 6.1_
    - _Design: Service-role allowlist and CI static check (Allowlist representation); Group (d) table; "Provisioning is deliberately absent"_

  - [x] 1.6 Add the blocking CI static check and ESLint rule, wired into CI
    - `scripts/check-service-role-usage.mjs`: statically scan `app/**` and `src/**` for importers/usages of `createServiceRoleClient`; fail if any importer is not in `service-role-allowlist.ts`; expose as an npm script (runs under Node 22)
    - ESLint `no-restricted-imports` forbidding `@/src/lib/supabase/service-role` everywhere, with `overrides` permitting only the allowlisted paths
    - Add both to `.github/workflows/ci.yml` as a **BLOCKING** step (fails the build; distinct from the existing non-blocking lint)
    - _Requirements: 10.3, 10.5_
    - _Design: Service-role allowlist and CI static check (CI / static enforcement)_

  - [x]* 1.7 Write a fixture test for the static check script
    - Assert the script flags a disallowed importer and passes an allowlisted one
    - _Requirements: 10.3, 10.5_
    - _Design: Testing Strategy → CI static checks (fixture test)_

- [x] 2. Checkpoint — scaffolding is behavior-neutral
  - Ensure all tests pass and the app behaves identically with the flag disabled, ask the user if questions arise.

- [x] 3. Database schema & provisioning migrations
  - [x] 3.1 Create core identity/workspace tables, enum, and uniqueness constraints
    - SQL migration: `user_profiles`, `account_workspaces` (with partial unique index `uq_personal_workspace` on `(owner_user_id) WHERE kind='personal'`), `workspace_role` enum, `workspace_memberships` (UNIQUE `(workspace_id, user_id)`, `idx_membership_by_user`)
    - _Requirements: 6.1, 6.2, 7.2, 22.1, 22.3_
    - _Design: Data Models → New tables; Schema readiness (Req 22)_

  - [x] 3.2 Re-parent `graph_workspaces` and `conversations`; add `migration_runs`
    - Add `account_workspace_id UUID` to `graph_workspaces` (FK, ON DELETE CASCADE), retaining legacy `workspace_id`
    - Add `account_workspace_id UUID` to `conversations` (FK, ON DELETE SET NULL); rename `workspace_id`→`legacy_workspace_id` (retain legacy column)
    - Create `migration_runs` (PK `user_id`, `kind`, `completed_at`)
    - Leave `messages`/`nodes`/`edges`/`conversation_node_positions` keyed by `conversation_id` (scoped transitively)
    - _Requirements: 11.1, 11.8_
    - _Design: Data Models → Re-parenting existing tables; UUID_Migration (migration_runs)_

  - [x] 3.3 Create the `provision_user()` SECURITY DEFINER trigger on `auth.users`
    - `public.provision_user()` (SECURITY DEFINER, `search_path=public`) inserting profile + personal workspace + membership with `ON CONFLICT DO NOTHING`; `CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users`
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 21.4_
    - _Design: Components → 5. Provisioning (trigger)_

  - [x] 3.4 Create the `provision_self()` auth.uid()-bound SECURITY DEFINER RPC
    - `public.provision_self()` RETURNS void, SECURITY DEFINER, `SET search_path=''`, subject = `auth.uid()` (NO uid parameter, NO service-role); raises if caller unauthenticated; same idempotent `ON CONFLICT DO NOTHING` upsert of the three records
    - _Requirements: 6.3, 6.5, 10.3, 12.1_
    - _Design: Components → 5. Provisioning (provision_self fallback)_

  - [x] 3.5 Create the debug authorization helpers (no uid param, boolean-only)
    - `public.is_member_with_role(target_workspace uuid, required_role workspace_role)` and `public.has_debug_access()` — SECURITY DEFINER, STABLE, `SET search_path=''`, subject bound to `auth.uid()`, no caller-supplied uid, return boolean only
    - _Requirements: 9.2, 9.3, 10.4_
    - _Design: Components → 3. Middleware ("Why no uid parameter"); 6. Authorization helpers_

  - [x] 3.6 Enable RLS and add membership policies on all user-data tables (default-deny)
    - `public.is_member(ws uuid)` helper (SECURITY DEFINER, STABLE)
    - `ENABLE ROW LEVEL SECURITY` on `account_workspaces`, `workspace_memberships`, `graph_workspaces`, `conversations`, `messages`, `nodes`, `edges`, `conversation_node_positions`
    - Policies: `mem_self`, `ws_member`, `graph_member`, `conv_member`, and transitive `msg_member` + identical patterns for `nodes`/`edges`/`conversation_node_positions`
    - Replace the existing service-role-only `graph_workspaces` policy (migration `20260819004606`) with membership policies
    - _Requirements: 7.4, 7.5, 10.1, 10.4_
    - _Design: Data Models → RLS policies_

  - [x]* 3.7 Write property test for the membership/RLS predicate
    - **Property 3: Workspace data access is membership-scoped with default-deny**
    - **Validates: Requirements 7.4, 7.5, 10.4**
    - Pure in-memory model of `is_member` over generated users/workspaces/membership sets; access iff a linking membership exists; empty memberships ⇒ deny all
    - _Design: Testing Strategy → Property-based (P3)_

  - [x]* 3.8 Write a schema/smoke test for membership uniqueness and no shared-workspace UI
    - Assert `workspace_memberships` is unique on `(workspace_id, user_id)` (multi-member capable); assert no shared/team workspace UI or multi-member flow ships
    - No Redis / no raw PG pool introduced
    - _Requirements: 5.2, 5.3, 22.1, 22.2_
    - _Design: Testing Strategy → Smoke/schema tests_

- [ ] 4. Checkpoint — schema & provisioning deployed and verified
  - Ensure all tests pass, ask the user if questions arise. (Live trigger-in-same-transaction and end-to-end RLS are MANUAL-ONLY — see Notes.)

- [ ] 5. Refactor shared DB helpers to accept a passed-in Supabase client (foundational — BEFORE flipping routes)
  - [ ] 5.1 Refactor `src/lib/db/*` helpers to take a client parameter
    - Change `src/lib/db/conversations.ts`, `messages.ts`, `nodes.ts`, `edges.ts`, `graph-workspaces.ts` (and siblings) that currently import the service-role client to accept a passed-in Supabase client argument; remove internal service-role imports from request-reachable helpers
    - Keep behavior identical when passed the existing client (no route flip yet)
    - _Requirements: 10.1, 10.2_
    - _Design: Service-Role Migration & Cutover Plan (transitive via `src/lib/db/*`); Architecture risk flag_

  - [ ] 5.2 Refactor `src/lib/intelligence*/**` helpers to take a client parameter
    - Change `src/lib/intelligence-v2/incremental/update-runner.ts`, `sie/commit-manager.ts`, `sie/reservation-orchestrator.ts`, `sie/identity-context-loader.ts` to accept a passed-in client on request-triggered paths; keep the recovery/background trigger (`triggerRecoveryOnce`) on the service-role allowlist (group (d))
    - _Requirements: 10.1, 10.2, 10.3_
    - _Design: Group (b) RPC paths; Group (d) allowlist_

  - [ ]* 5.3 Write unit tests confirming helpers use the passed-in client
    - Assert each refactored helper performs reads/writes through the injected client and no longer imports the service-role factory on request paths
    - _Requirements: 10.1, 10.2_

- [ ] 6. Auth plumbing (session, authorization, debug, middleware)
  - [ ] 6.1 Rewrite `src/lib/auth/session.ts` to be identity-only via getClaims
    - `getAuthClaims(client)` returns `{ userId: claims.sub, email }` or `null`; canonical identity is `claims.sub` (never the Google subject); no manual Google ID-token / self-JWT verification; no cache/PG pool
    - Remove the HMAC `cg_session` create/get/destroy
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1_
    - _Design: Components → 2. Session validator_

  - [ ]* 6.2 Write property test for claims-to-identity mapping
    - **Property 1: Claims resolve to the canonical Supabase user id or unauthenticated**
    - **Validates: Requirements 4.1, 4.2, 4.4**
    - Generate claims objects (with/without `sub`, with extra provider/Google-subject fields); assert returns `sub` or `null`, never a provider subject
    - _Design: Testing Strategy → Property-based (P1)_

  - [ ] 6.3 Rewrite `src/lib/auth/authorization.ts` (`requireUser` + `ensureProvisioned`)
    - `requireUser()` reads `getClaims()` (identity only) then calls `ensureProvisioned()`; 401 if no claims
    - `ensureProvisioned()` runs under the user-scoped client bound to `auth.uid()`: verify the three rows exist, else call `.rpc('provision_self')`; deny access until all three confirmed; NEVER service-role
    - Drop `requireConversationAccess`'s manual `workspace_id` check in favor of RLS; preserve cross-workspace 404 (zero rows → 404)
    - _Requirements: 6.4, 6.5, 6.6, 7.2, 7.4, 10.1, 10.2_
    - _Design: Components → 5 (provisioning gate), 6 (authorization helpers)_

  - [ ]* 6.4 Write property test for provisioning idempotency and access gating
    - **Property 2: Provisioning is idempotent and gates access on all three records**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 21.4**
    - In-memory upsert model; arbitrary pre-existing subsets and repeat counts; exactly-one-of-each, reuse, access-granted iff all three present
    - _Design: Testing Strategy → Property-based (P2)_

  - [ ] 6.5 Rewrite `src/lib/auth/debug.ts` (`requireDebugAccess`, current-membership check)
    - Verify the debug flag, then perform a CURRENT server-side membership+role lookup via the user-scoped client or the no-uid `has_debug_access()`/`is_member_with_role(...)` helper; 404 unless the user currently holds the required role; never read a role from the JWT
    - _Requirements: 9.1, 9.2, 9.3_
    - _Design: Components → 3 (debug role check), 6 (requireDebugAccess)_

  - [ ]* 6.6 Write the debug-gate-reads-current-membership example test
    - `requireDebugAccess()` returns 404 after a role is revoked with NO token refresh (mocked current-membership lookup)
    - _Requirements: 9.2_
    - _Design: Testing Strategy → Example/integration (Debug gate reads current membership)_

  - [ ] 6.7 Rewrite `middleware.ts` to use the SSR middleware client with gating preserved
    - Build a middleware Supabase client bound to `(request, response)` cookies; `getClaims()` for identity only; allow `/api/auth`, `/auth/*`, `/login`, and static assets without a session
    - No claims: `/api/*` (non-auth) → 401 + `Cache-Control: no-store`; page → redirect `/login`
    - Debug_Route ONLY incurs a DB check (flag + current membership/role → 404 if lacking); non-debug paths stay identity-claims only
    - Return response with refreshed auth cookies via the SSR cookie handler; `no-store` on `/api/*`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3_
    - _Design: Components → 3. Middleware_

  - [ ]* 6.8 Write property test for the request-gating decision
    - **Property 4: The request-gating decision follows the gating table and depends on current membership**
    - **Validates: Requirements 8.1, 8.2, 8.3, 9.1, 9.2, 9.3**
    - Pure function of `(path, hasSession, flagEnabled, currentMembershipRole)`; assert gating table incl. `no-store` on API 401 and debug-only allowance; include a revoke-and-re-evaluate case that flips to 404 from the changed current-membership input (no token refresh)
    - _Design: Testing Strategy → Property-based (P4)_

- [ ] 7. Checkpoint — auth plumbing complete (flag still disabled)
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Auth callback routes and action handlers
  - [ ] 8.1 Implement `/auth/callback` (OAuth code exchange)
    - GET: `exchangeCodeForSession(code)` through the user-scoped SSR client; on success run the provisioning gate then redirect to the app; on failure redirect `/login?error=auth` with a generic message, no access; mint no JWT, verify no Google ID token, derive identity only from the exchanged code
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 20.4, 20.5_
    - _Design: Components → 4 (server callback routes); End-to-end flows_

  - [ ] 8.2 Implement `/auth/confirm` (email confirmation + recovery)
    - GET: `verifyOtp({ type, token_hash })`; `type=signup` → provisioning gate + app; `type=recovery` → establish Recovery_Session → redirect `/reset-password`; invalid/expired/used → generic error, no access/session
    - _Requirements: 14.1, 14.2, 14.4, 17.1, 17.3, 17.4, 20.3, 20.4, 20.5_
    - _Design: Components → 4 (server callback routes)_

  - [ ] 8.3 Implement the auth action handlers (Supabase-delegated)
    - `signInWithOAuth({ provider:'google', options:{ redirectTo:'/auth/callback', flowType:'pkce' }})` (Supabase owns PKCE verifier/challenge/state)
    - `signUp({ email, password, options:{ emailRedirectTo:'/auth/confirm' }})`; detect/ surface or retry failed verification-email send
    - `signInWithPassword` (generic error on rejection); `resetPasswordForEmail(email, { redirectTo:'/auth/confirm?type=recovery' })` (non-enumerating identical response)
    - `updateUser({ password })` (change vs set-password branch); `signOut()` then confirm no valid session (report incomplete until invalidation confirmed)
    - Never store/hash/validate passwords; never log credentials/tokens; cookies only via the SSR handler
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 13.1, 13.2, 13.3, 13.4, 13.5, 14.3, 14.6, 15.1, 15.2, 15.3, 15.4, 15.5, 16.1, 16.2, 16.3, 16.4, 17.2, 18.1, 18.2, 18.3, 18.4, 19.1, 19.2, 19.3, 19.4, 12.4, 12.5_
    - _Design: Components → 4 (auth action handlers); Secret handling_

  - [ ] 8.4 Build the Auth_Screens with Astryx components
    - `/login` (Google + email/password), `/signup`, `/forgot-password`, `/reset-password`, `/set-password` (label switches to "Set Password" for Google users with no password), and an email-verification result screen
    - Use Astryx components (TextInput, Button, Banner) per workspace rules; replace the current credential-only `/login`
    - _Requirements: 18.2, 20.1, 20.2, 20.3_
    - _Design: Components → 4 (Auth_Screens)_

  - [ ]* 8.5 Write example/integration tests for callbacks and action handlers (mocked Supabase)
    - `/auth/callback` success + exchange failure; `/auth/confirm` signup/recovery with valid/invalid/expired/used tokens
    - Call-shape assertions for `signInWithOAuth` (google/pkce/redirectTo), `signUp`, `signInWithPassword` (generic error), `resetPasswordForEmail` (identical non-enumerating response), `updateUser` (change vs set-password + failure), `signOut` (success + invalidation-confirmation)
    - Redaction: no token/password fields in payloads or logs; service-role key never `NEXT_PUBLIC_`
    - _Requirements: 2.4, 12.2, 12.5, 13.4, 14.4, 15.3, 16.2, 16.3, 17.4, 18.4, 19.3_
    - _Design: Testing Strategy → Example/integration; Redaction_

  - [ ]* 8.6 Write route-presence smoke tests for all Auth_Screens and callbacks
    - Assert all auth screens and `/auth/callback` + `/auth/confirm` routes exist
    - _Requirements: 20.1, 20.2, 20.3, 20.4_
    - _Design: Testing Strategy → Smoke/schema tests_

- [ ] 9. Checkpoint — auth flows wired (flag still disabled)
  - Ensure all tests pass, ask the user if questions arise. (Real OAuth/PKCE, cookie refresh on Vercel, real email/token flows, same-email identity linking are MANUAL-ONLY — see Notes.)

- [ ] 10. Route conversion — Batch 1: conversations & messages (group (a), user-scoped client)
  - [ ] 10.1 Convert conversation/message routes to the user-scoped client
    - `app/api/conversations/route.ts`, `conversations/generate-title/route.ts`, `conversation/route.ts`, `messages/route.ts`, `messages/edit/route.ts`, `conversation-node-positions/route.ts` → pass `createUserScopedClient()` into the refactored helpers; drop manual `workspace_id`/`requireConversationAccess` string checks in favor of RLS
    - _Requirements: 7.4, 10.1, 10.2_
    - _Design: Group (a) inventory (conversations/messages rows)_

  - [ ]* 10.2 Write negative cross-workspace tests for Batch 1
    - For each route: a non-member of the target workspace → 404/empty (never another workspace's rows)
    - _Requirements: 7.4, 10.1_
    - _Design: Testing Strategy → Negative cross-workspace tests; Group (a) "negative cross-workspace test" column_

- [ ] 11. Route conversion — Batch 2: nodes, graph-dashboard, attachments & storage (groups (a)+(c))
  - [ ] 11.1 Convert node/graph/draft/evolve/structure routes to the user-scoped client
    - `app/api/nodes/route.ts`, `draft-node/route.ts`, `structure-conversation/route.ts`, `evolve-graph/route.ts`, `evolve-apply/route.ts`, `graph-dashboard/route.ts`, `graph-summary/route.ts` → user-scoped client (RLS via conversation / `account_workspace_id`)
    - _Requirements: 7.4, 10.1, 10.2_
    - _Design: Group (a) inventory (nodes/graph rows)_

  - [ ] 11.2 Convert attachments route + storage operations to the user-scoped client
    - `app/api/attachments/route.ts` (rows + Storage upload/signed/download) and request-triggered Storage deletes in `src/lib/attachments.ts` / `src/lib/db/conversations.ts` → user-scoped client (Storage RLS / per-object policies); bulk/system cleanup stays on the allowlist (group (d))
    - _Requirements: 7.4, 10.1, 10.2, 10.3_
    - _Design: Group (a) + Group (c) inventories_

  - [ ]* 11.3 Write negative cross-workspace tests for Batch 2
    - Each route + storage op: non-member → 404/empty/denied
    - _Requirements: 7.4, 10.1_
    - _Design: Testing Strategy → Negative cross-workspace tests_

- [ ] 12. Route conversion — Batch 3: graph-workspaces & v2 (groups (a)+(b))
  - [ ] 12.1 Convert graph-workspaces routes to the user-scoped client
    - `app/api/graph-workspaces/route.ts`, `[id]/load/route.ts`, `[id]/save/route.ts`, `conversations/route.ts` → user-scoped client (RLS on `graph_workspaces`)
    - _Requirements: 7.4, 10.1, 10.2_
    - _Design: Group (a) inventory (graph-workspaces rows)_

  - [ ] 12.2 Convert v2 routes and their RPC paths to the user-scoped client
    - `app/api/v2/graph-snapshot/route.ts` (direct + `.rpc`), `v2/manual-node/route.ts`, `v2/paste-nodes/route.ts`, `app/api/chat/route.ts` → user-scoped client; RPC runs under `auth.uid()`; SECURITY DEFINER RPC bodies keep membership checks; request-triggered intelligence `.rpc` paths use the injected user-scoped client
    - _Requirements: 7.4, 10.1, 10.2, 10.3_
    - _Design: Group (a) + Group (b) inventories_

  - [ ]* 12.3 Write negative cross-workspace tests for Batch 3 (routes + RPC paths)
    - Each route/RPC: non-member → 404/empty, no cross-workspace effect
    - _Requirements: 7.4, 10.1_
    - _Design: Testing Strategy → Negative cross-workspace tests; Group (b)_

- [ ] 13. Route conversion — Batch 4: debug routes (group (a), gated by requireDebugAccess)
  - [ ] 13.1 Convert all `/api/debug/*` routes to the user-scoped client and `requireDebugAccess()`
    - Convert benchmark, candidate-timeline, candidates, engine-state, message-order, migrate-engine-state, obj-trace, pipeline, pipeline-health, reembed-nodes, v2-incremental, v2-trace, plus the `src/lib/db`-backed calibrate-thresholds, edge-candidates, neighborhoods, node-pairs, persist-edges, suggestions, topic-shifts to the user-scoped client; gate each with `requireDebugAccess()`; any genuinely cross-workspace diagnostic that must bypass RLS is explicitly allowlisted as group (d)
    - _Requirements: 9.1, 9.2, 9.3, 10.1, 10.2_
    - _Design: Group (a); Debug routes note_

  - [ ]* 13.2 Write negative cross-workspace + gate tests for debug routes
    - Non-member/insufficient-role → 404; flag-disabled-outside-dev → 404; current-membership drives the decision
    - _Requirements: 9.1, 9.2, 9.3_
    - _Design: Testing Strategy → Negative cross-workspace tests; Debug gate_

- [ ] 14. Checkpoint — all group (a)/(b)/(c) routes converted; only group (d) remains service-role
  - Ensure all tests pass and the CI static check is green (no non-allowlisted request-path importer of the service-role factory), ask the user if questions arise.

- [ ] 15. UUID_Migration (privileged, allowlisted; group (d))
  - [ ] 15.1 Implement the `migrate_owner_data_to_user(target_user)` SQL function
    - Parent-first ordering: resolve target personal `account_workspace_id`; re-parent `graph_workspaces` keeping each original `id` (no merge/flatten); re-parent `conversations` where `legacy_workspace_id='owner'`; dependents follow by unchanged IDs; record completion in `migration_runs`; skip-if-done when a `migration_runs` row exists; move only rows still pointing at legacy `'owner'`; exclude `'demo'` from every WHERE clause
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10_
    - _Design: Data Models → UUID_Migration_

  - [ ] 15.2 Implement the `UUID_Migration` runner on the allowlisted service-role path
    - `src/lib/migration/uuid-migration.ts` calling `createServiceRoleClient({ allowServiceRole: true })`; gated on the real Supabase_User_Id supplied after first sign-in; must not run before the UUID is known; idempotent via `migration_runs`
    - _Requirements: 11.2, 11.3, 11.4, 10.3_
    - _Design: Components → 7. UUID_Migration runner; Group (d) allowlist_

  - [ ]* 15.3 Write property test — migration idempotency
    - **Property 5: The UUID_Migration is idempotent**
    - **Validates: Requirements 11.3, 11.4**
    - Pure in-memory relational dataset transform; run once then again with same target → identical state
    - _Design: Testing Strategy → Property-based (P5)_

  - [ ]* 15.4 Write property test — reassociation completeness + referential integrity
    - **Property 6: The UUID_Migration reassociates all owner data with referential integrity preserved**
    - **Validates: Requirements 11.1, 11.2, 11.5, 11.10**
    - _Design: Testing Strategy → Property-based (P6)_

  - [ ]* 15.5 Write property test — distinct Dashboard_Graph preservation (no flatten)
    - **Property 7: The UUID_Migration preserves each Dashboard_Graph as a distinct child**
    - **Validates: Requirements 11.8, 11.9**
    - _Design: Testing Strategy → Property-based (P7)_

  - [ ]* 15.6 Write property test — demo data untouched
    - **Property 8: The UUID_Migration never touches demo data**
    - **Validates: Requirements 11.6, 11.7**
    - _Design: Testing Strategy → Property-based (P8)_

- [ ] 16. Checkpoint — migration verified
  - Ensure all tests pass, ask the user if questions arise. (Live owner-dataset migration against a real project is MANUAL-ONLY — see Notes.)

- [ ] 17. Cutover (STRICT LAST STEP — no window where real sessions coexist with RLS-bypassing routes)
  - [ ] 17.1 Verify the 8-item enable checklist is green, then flip the flag and remove legacy login
    - Programmatically assert enable-checklist items 1–8 hold: (1) tables/enum/RLS/trigger deployed; (2) provisioning + owner `UUID_Migration` complete (demo untouched); (3) every group (a) route user-scoped with passing negative tests; (4) every group (b) RPC under user-scoped client with membership enforced; (5) every group (c) storage op user-scoped; (6) allowlist contains ONLY `UUID_Migration` + offline/system jobs and the blocking CI static check passes; (7) hard-violation guard active and unit-tested; (8) `requireDebugAccess()` enforces current-membership on all debug routes
    - Only after all green: flip `AUTH_SUPABASE_CUTOVER_ENABLED` → `true`, switching session validation, middleware gating, and converted routes to the user-scoped (RLS) path
    - Remove the legacy owner/demo HMAC `cg_session` login and `TEMP_OWNER_*`/`TEMP_DEMO_*` credential paths; this is the LAST step with no coexistence window
    - _Requirements: 7.1, 7.3, 10.1, 10.2, 10.3_
    - _Design: Cutover gate (enable criteria/checklist, hard ordering invariant)_

  - [ ]* 17.2 Write a release-gate test asserting the cutover ordering invariant
    - Assert the flag cannot be enabled while any group (a)/(b)/(c) route imports the service-role factory on its request path (ties to the blocking CI static check)
    - _Requirements: 10.1, 10.2, 10.3_
    - _Design: Error Handling ("Cutover enabled while a request path still bypasses RLS")_

- [ ] 18. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (and design sections) for traceability.
- Property-based tests (`fast-check` + Vitest, Node 22, min 100 runs) validate the eight correctness properties against pure in-memory models and are tagged `// Feature: google-oauth-authentication, Property N: ...`.
- Example/integration tests use a mocked Supabase client; smoke/schema tests assert structure (route presence, membership uniqueness, no Redis/PG pool, no shared-workspace UI).
- **Sequencing is a hard requirement:** scaffolding (1) → schema/provisioning (3) → shared-helper refactor (5) → auth plumbing (6) → auth flows (8) → route conversion batches (10–13) → `UUID_Migration` (15) → cutover (17). The flag flip in 17 is the strict last step; there must be no deployment window where real multi-user sessions coexist with ordinary routes that still bypass RLS.
- **MANUAL-ONLY against a live Supabase project (not automated):**
  - End-to-end Google OAuth + PKCE redirect and real `exchangeCodeForSession` (Req 1, 2).
  - Supabase-managed cookie lifecycle and access-token refresh on Vercel serverless via the SSR middleware client (Req 3).
  - Real verification / password-reset email send, token validity, and single-use expiry (Req 14, 16, 17).
  - Same-email identity linking across Google and email/password resolving to one `auth.users.id` (Req 21.1, 21.2) — a Supabase project configuration dependency.
  - The `provision_user` trigger firing in the same transaction as the `auth.users` insert, and live RLS enforcement end-to-end through the user-scoped client (Req 6, 10).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.5"] },
    { "id": 2, "tasks": ["1.4", "1.6", "3.1"] },
    { "id": 3, "tasks": ["1.7", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 4, "tasks": ["3.6", "3.7", "3.8"] },
    { "id": 5, "tasks": ["5.1", "5.2"] },
    { "id": 6, "tasks": ["5.3", "6.1", "6.3", "6.5", "6.7"] },
    { "id": 7, "tasks": ["6.2", "6.4", "6.6", "6.8"] },
    { "id": 8, "tasks": ["8.1", "8.2", "8.3", "8.4"] },
    { "id": 9, "tasks": ["8.5", "8.6"] },
    { "id": 10, "tasks": ["10.1", "11.1", "11.2", "12.1", "12.2", "13.1"] },
    { "id": 11, "tasks": ["10.2", "11.3", "12.3", "13.2"] },
    { "id": 12, "tasks": ["15.1", "15.2"] },
    { "id": 13, "tasks": ["15.3", "15.4", "15.5", "15.6"] },
    { "id": 14, "tasks": ["17.1"] },
    { "id": 15, "tasks": ["17.2"] }
  ]
}
```
