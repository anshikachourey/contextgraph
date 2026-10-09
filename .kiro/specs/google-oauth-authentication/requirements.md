# Requirements Document

## Introduction

This feature adds Google sign-in and Supabase-managed email/password authentication to ContextGraph using Supabase Auth as the sole identity and session authority. It replaces the current environment-variable owner/demo credential login (the HMAC `cg_session` cookie and `TEMP_OWNER_*`/`TEMP_DEMO_*` credentials) with real authenticated users who belong to workspaces through membership records.

The design delegates identity, token management, and session handling to Supabase. Google sign-in runs through `@supabase/ssr` using `supabase.auth.signInWithOAuth` with the PKCE flow, and a server-side callback route exchanges the authorization code for a session via `exchangeCodeForSession`. Email/password authentication is also delegated entirely to Supabase Auth: ContextGraph submits credentials through the supported Supabase Auth methods (`supabase.auth.signUp`, `supabase.auth.signInWithPassword`, `supabase.auth.resetPasswordForEmail`, `supabase.auth.updateUser`, `supabase.auth.verifyOtp` / email confirmation handling, and `supabase.auth.signOut`), but ContextGraph never stores, hashes, or validates passwords itself. Supabase manages the access token, the refresh token, and the auth cookies through the supported SSR cookie interface for every authentication method. The application does not build a custom Google OAuth flow, implement its own password storage or verification, mint its own application JWTs, verify Google ID tokens manually, or hand-roll session cookies or refresh logic. Protected server requests validate the session through Supabase's server client and `getClaims()`. The canonical identity is the Supabase user UUID (`auth.users.id`), not the Google provider subject.

Signup with email and password triggers Supabase-managed email verification, and email confirmation, password reset, and recovery flows are processed server-side through supported Supabase callback/confirmation handling. Google sign-in and email/password sign-in for the same email resolve to the same canonical `auth.users.id` using Supabase-supported identity behavior, and ContextGraph does not implement any custom account-merging logic. Both authentication methods share the same idempotent provisioning flow.

On first application access through any authentication method, the user's profile, a personal account workspace, and workspace membership are provisioned through an idempotent transaction or an `auth.users` database trigger, keyed by `auth.users.id`, before any usable application access is granted. Authorization decisions, including the existing debug-route gating, derive from authenticated workspace membership and role rather than the removed owner/demo environment credentials. Existing owner-workspace data and all dependent records are reassociated to the real authenticated user's personal workspace through an explicit migration that runs only after the user supplies the real Supabase user UUID obtained from their first sign-in, while existing demo-workspace data remains separate and unchanged until the user explicitly decides what to do with it. Row Level Security remains the final authorization boundary: ordinary application data access goes through the user-scoped Supabase client so RLS applies, and does not bypass RLS through service-role or direct-database access.

ContextGraph runs on Next.js 16 (App Router) with Supabase/PostgreSQL, deployed on Vercel. `supabase-js` is already a dependency; `@supabase/ssr` is added by this feature. Redis and a raw PostgreSQL connection pool are explicitly not part of this feature. All npm commands run on Node 22. Tests use Vitest with fast-check.

## Glossary

- **ContextGraph**: The Next.js 16 (App Router) application that this authentication system protects.
- **Auth_System**: The collection of components implementing Google sign-in, provisioning, session validation, and membership-based authorization defined by this document, built on Supabase Auth.
- **Supabase_Auth**: The managed Supabase authentication service that owns Google OAuth, PKCE state, token issuance, token verification, token refresh, and auth-cookie management for this feature.
- **SSR_Client**: The `@supabase/ssr` server client and middleware integration that reads and writes Supabase auth cookies through the supported SSR cookie handler interface.
- **Sign_In_Initiator**: The component that begins Google sign-in by calling `supabase.auth.signInWithOAuth` with the Google provider and the PKCE flow.
- **Callback_Route**: The server-side route that receives Google's redirect and calls `exchangeCodeForSession` to establish the Supabase session.
- **Email_Password_Credentials**: An email address and password pair that ContextGraph submits to Supabase_Auth through the supported Supabase Auth methods, and that ContextGraph never stores, hashes, or validates itself.
- **Email_Verification**: The Supabase-managed confirmation of a user's email address, triggered by signup and completed server-side by processing the Supabase-issued verification token hash or code through the supported Supabase method.
- **Password_Reset**: The Supabase-managed flow in which `supabase.auth.resetPasswordForEmail` sends a reset email and the user subsequently sets a new password through a recovery session.
- **Recovery_Session**: The Supabase session established server-side from a password-reset or recovery callback that authorizes the user to set a new password via `supabase.auth.updateUser`.
- **Identity_Unification**: The Supabase-supported resolution of Google sign-in and email/password sign-in for the same email address to a single canonical Supabase_User_Id, without ContextGraph implementing custom account-merging logic.
- **Auth_Screen**: Any ContextGraph route or screen that supports an authentication interaction, including login, signup, forgot-password, reset-password, set/change-password, and the email-verification result, together with its server-side callback state.
- **Session_Validator**: The component (used by middleware and route handlers) that validates the Supabase session server-side using the server client and `getClaims()`.
- **Supabase_User_Id**: The Supabase user UUID (`auth.users.id`), which is the canonical identity for a user in ContextGraph.
- **Google_Provider_Subject**: The Google-issued subject identifier for the account, which is not used as the canonical identity.
- **User_Profile**: The application profile record for an authenticated user, keyed by Supabase_User_Id.
- **Account_Workspace**: The personal workspace provisioned for an authenticated user, which the user belongs to via a Workspace_Membership record.
- **Workspace_Membership**: A record associating a Supabase_User_Id with a workspace and a role, from which authorization decisions derive.
- **Provisioning**: The idempotent creation of the User_Profile, the Account_Workspace, and the Workspace_Membership, keyed by Supabase_User_Id, performed before usable application access.
- **User_Scoped_Client**: The Supabase client that acts under the authenticated user's session so that Row Level Security applies to data access.
- **RLS**: Supabase Row Level Security, the final authorization boundary for ordinary application data access.
- **Service_Role_Client**: A privileged Supabase client that bypasses RLS, restricted to non-request privileged paths.
- **Protected_Request**: Any request to a non-public ContextGraph page or API route that requires an authenticated Supabase session.
- **Debug_Route**: A route under `/api/debug/*` or `/debug/*` whose access is gated behind a debug flag and workspace membership/role.
- **UUID_Migration**: The explicit, one-time migration that reassociates existing owner-workspace data to the authenticated user's Account_Workspace once the real Supabase_User_Id is known.
- **Owner_Workspace_Data**: All records associated with the environment-variable owner workspace, including the workspace rows, conversations, graph data, nodes, edges, messages, node positions, and any dependent records that reference the owner workspace or owner-owned rows.
- **Demo_Workspace_Data**: All records associated with the demo workspace, which the UUID_Migration must not read, modify, reassociate, or delete.
- **Dashboard_Graph**: An individual graph entity within the ContextGraph dashboard, corresponding to the existing graph-workspace concept, that exists as a child entity of an Account_Workspace and has its own graph identifier, conversation memberships, nodes, edges, node positions, and provenance.

## Requirements

### Requirement 1: Google sign-in via Supabase with PKCE

**User Story:** As a user, I want to sign in with my Google account, so that I can access ContextGraph without managing a separate password.

#### Acceptance Criteria

1. WHEN a user initiates sign-in, THE Sign_In_Initiator SHALL start the Google flow by calling `supabase.auth.signInWithOAuth` with the Google provider configured to use the PKCE flow.
2. THE Sign_In_Initiator SHALL rely on Supabase_Auth to generate and manage the PKCE code verifier, code challenge, and OAuth state value.
3. THE Sign_In_Initiator SHALL NOT generate, store, or validate its own OAuth state value.
4. WHEN starting the Google flow, THE Sign_In_Initiator SHALL set the OAuth redirect target to the Callback_Route.

### Requirement 2: Server-side authorization code exchange

**User Story:** As a user, I want ContextGraph to complete sign-in on the server, so that my session is established securely.

#### Acceptance Criteria

1. WHEN the Callback_Route receives Google's redirect with an authorization code, THE Callback_Route SHALL exchange the code for a Supabase session by calling `exchangeCodeForSession` through the SSR_Client.
2. THE Callback_Route SHALL rely on Supabase_Auth to issue and manage the access token and the refresh token.
3. THE Callback_Route SHALL NOT mint an application JWT, SHALL NOT verify the Google ID token manually, and SHALL NOT derive identity from browser-supplied parameters other than the authorization code consumed by `exchangeCodeForSession`.
4. IF the code exchange fails, THEN THE Callback_Route SHALL reject sign-in with an authentication error and SHALL NOT grant application access.

### Requirement 3: Supabase controls auth cookies and refresh

**User Story:** As a security reviewer, I want session cookies and refresh handled by the supported Supabase SSR integration, so that cookie and token lifecycle is not hand-rolled.

#### Acceptance Criteria

1. THE Auth_System SHALL read and write Supabase auth cookies exclusively through the SSR_Client cookie handler interface in middleware and the server client.
2. THE Auth_System SHALL NOT set, clear, or modify Supabase auth cookies manually outside the SSR_Client cookie handler interface.
3. THE Auth_System SHALL rely on Supabase_Auth and the SSR_Client to perform access-token refresh using the Supabase-managed refresh token.
4. THE Auth_System SHALL NOT implement a custom refresh-token credential, a custom refresh endpoint, or custom session-cookie signing.

### Requirement 4: Server-side session validation via getClaims

**User Story:** As an operator, I want protected requests validated server-side through Supabase, so that access control relies on verified session claims.

#### Acceptance Criteria

1. WHEN validating a Protected_Request, THE Session_Validator SHALL verify the session server-side using the Supabase server client and `getClaims()`.
2. WHEN a session is valid, THE Session_Validator SHALL resolve the authenticated identity as the Supabase_User_Id from the verified claims.
3. THE Session_Validator SHALL NOT use the Google_Provider_Subject as the canonical identity.
4. IF `getClaims()` returns no valid session, THEN THE Session_Validator SHALL treat the Protected_Request as unauthenticated.
5. THE Session_Validator SHALL NOT manually verify Google ID tokens and SHALL NOT validate a self-minted application JWT.

### Requirement 5: Redis and PostgreSQL pool excluded from this feature

**User Story:** As an operator, I want session and user-context resolution to go through Supabase, so that no custom cache or raw database pool is introduced for authentication.

#### Acceptance Criteria

1. THE Auth_System SHALL resolve session and user context through Supabase_Auth and the Supabase client, not through a custom cache or a raw PostgreSQL connection pool.
2. THE Auth_System SHALL NOT introduce Redis as part of this feature.
3. THE Auth_System SHALL NOT introduce a raw PostgreSQL connection pool as part of this feature.

### Requirement 6: Idempotent provisioning before application access

**User Story:** As an operator, I want each authenticated user's profile, workspace, and membership created before access, so that no user reaches the application without backing records regardless of how they authenticated.

#### Acceptance Criteria

1. WHEN a user obtains first authenticated access regardless of authentication method, THE Auth_System SHALL provision the User_Profile, the Account_Workspace, and the Workspace_Membership through an idempotent transaction OR an `auth.users` insert trigger.
2. THE Auth_System SHALL key Provisioning records by the Supabase_User_Id.
3. WHEN the same user signs in again through any authentication method, THE Auth_System SHALL complete Provisioning without creating duplicate User_Profile, Account_Workspace, or Workspace_Membership records.
4. THE Auth_System SHALL NOT grant usable application access before the User_Profile, the Account_Workspace, and the Workspace_Membership are durably committed.
5. IF Provisioning fails after some Provisioning records are already durably committed, THEN THE Auth_System SHALL deny application access with an error, SHALL leave the already-committed Provisioning records in place for an idempotent retry to complete the remaining records, and SHALL NOT leave partial Provisioning records that grant access.
6. WHERE a Supabase_User_Id already holds provisioned records from a prior authentication method, THE Auth_System SHALL reuse the existing User_Profile, Account_Workspace, and Workspace_Membership rather than provisioning a second set.

### Requirement 7: Membership-based authorization replaces owner/demo credentials

**User Story:** As a developer, I want authorization driven by authenticated workspace membership, so that the removed owner/demo environment credentials are no longer the basis for access.

#### Acceptance Criteria

1. THE Auth_System SHALL replace the environment-variable owner/demo credential login and the HMAC `cg_session` cookie with Supabase Google sign-in and Supabase-managed sessions.
2. THE Auth_System SHALL derive authorization decisions from the authenticated user's Workspace_Membership and role.
3. THE Auth_System SHALL NOT derive authorization from the `TEMP_OWNER_*` or `TEMP_DEMO_*` environment credentials.
4. WHERE a user belongs to a workspace through a Workspace_Membership, THE Auth_System SHALL scope that user's workspace data access to workspaces in which the user holds a Workspace_Membership.
5. IF an authenticated user holds no Workspace_Membership, THEN THE Auth_System SHALL deny access to all workspace data, enforced through RLS policies scoped to the user's Workspace_Membership.

### Requirement 8: Middleware session gating preservation

**User Story:** As a developer, I want the existing middleware gating behavior preserved under Supabase sessions, so that page and API protection behaves consistently after the migration.

#### Acceptance Criteria

1. WHEN an unauthenticated Protected_Request targets an API route other than the auth routes, THE Auth_System SHALL respond with HTTP status 401 and a `no-store` cache directive.
2. WHEN an unauthenticated Protected_Request targets a page route, THE Auth_System SHALL redirect the request to `/login`.
3. WHERE a request targets an authentication route or the `/login` page, THE Auth_System SHALL allow the request without a session.
4. WHEN the Session_Validator validates a Protected_Request within middleware, THE Session_Validator SHALL determine authentication using the Supabase server client and `getClaims()` through the SSR_Client.

### Requirement 9: Debug-route authorization via membership

**User Story:** As an operator, I want debug routes to remain restricted after the migration, so that diagnostic surfaces stay protected while using membership-based authorization.

#### Acceptance Criteria

1. IF a request targets a Debug_Route WHILE the debug feature flag is disabled outside development, THEN THE Auth_System SHALL respond with HTTP status 404.
2. IF an authenticated request targets a Debug_Route WHILE the authenticated user lacks the Workspace_Membership role required for debug access, THEN THE Auth_System SHALL respond with HTTP status 404.
3. WHERE an authenticated request targets a Debug_Route WHILE the authenticated user holds the Workspace_Membership role required for debug access AND the debug feature flag is enabled, THE Auth_System SHALL allow that Debug_Route request to proceed, and this allowance SHALL apply only to requests targeting a Debug_Route.

### Requirement 10: RLS as the final authorization boundary

**User Story:** As a security reviewer, I want ordinary data access to pass through RLS, so that authorization cannot be bypassed by request handlers.

#### Acceptance Criteria

1. WHEN serving a Protected_Request that reads or writes ordinary application data, THE Auth_System SHALL access data through the User_Scoped_Client so that RLS applies.
2. THE Auth_System SHALL NOT access ordinary application data for a Protected_Request through the Service_Role_Client or direct database access that bypasses RLS.
3. WHERE the Service_Role_Client is used, THE Auth_System SHALL restrict its use to privileged non-request paths.
4. THE Auth_System SHALL scope RLS policies for user data to the Supabase_User_Id through `auth.uid()` and the user's Workspace_Membership.
5. IF the Service_Role_Client is used outside a privileged non-request path, THEN THE Auth_System SHALL treat the use as a hard violation and SHALL block the operation.

### Requirement 11: Explicit data migration to the real user UUID

**User Story:** As a developer, I want all existing owner-workspace data and its dependent records reassociated to my real authenticated workspace with referential integrity preserved, so that prior work remains available after sign-in while demo data stays untouched.

#### Acceptance Criteria

1. THE UUID_Migration SHALL reassociate all Owner_Workspace_Data, including workspace rows, conversations, graph data, nodes, edges, messages, node positions, and any dependent records that reference the owner workspace or owner-owned rows, to the authenticated user's Account_Workspace.
2. THE UUID_Migration SHALL use the real Supabase_User_Id supplied after the user's first sign-in to determine the target Account_Workspace.
3. THE UUID_Migration SHALL NOT run before the real Supabase_User_Id is known.
4. WHEN the UUID_Migration runs more than once with the same Supabase_User_Id, THE UUID_Migration SHALL NOT duplicate or re-reassociate records already reassociated to that user's Account_Workspace.
5. WHEN the UUID_Migration reassociates Owner_Workspace_Data, THE UUID_Migration SHALL preserve referential integrity across all dependent tables so that references between reassociated records remain valid.
6. THE UUID_Migration SHALL NOT read for modification, modify, reassociate, or delete any Demo_Workspace_Data.
7. WHILE the user has not explicitly decided what to do with Demo_Workspace_Data, THE UUID_Migration SHALL leave Demo_Workspace_Data separate from and unchanged relative to the authenticated user's Account_Workspace.
8. WHEN the UUID_Migration reassociates Owner_Workspace_Data, THE UUID_Migration SHALL preserve each Dashboard_Graph as a separate child entity within the target Account_Workspace and SHALL retain each Dashboard_Graph's original graph identifier.
9. WHEN the UUID_Migration reassociates Owner_Workspace_Data, THE UUID_Migration SHALL NOT merge or flatten two or more Dashboard_Graphs into a single Dashboard_Graph.
10. WHEN the UUID_Migration reassociates a Dashboard_Graph, THE UUID_Migration SHALL preserve that Dashboard_Graph's conversation memberships, nodes, edges, node positions, and provenance, and SHALL keep each of those records associated with the same Dashboard_Graph after migration.

### Requirement 12: Secret and credential handling constraints

**User Story:** As a security reviewer, I want Supabase keys and secrets handled safely, so that the feature introduces no new exposure.

#### Acceptance Criteria

1. THE Auth_System SHALL read the Supabase service-role key and other server-only secrets from server-side configuration only.
2. THE Auth_System SHALL exclude the Supabase service-role key and Supabase session tokens from response bodies, URLs, logs, and client-readable storage.
3. THE Auth_System SHALL use the Supabase anon key for browser and user-scoped clients so that RLS applies.
4. THE Auth_System SHALL submit Email_Password_Credentials only to Supabase_Auth through the supported Supabase Auth methods and SHALL NOT store, hash, persist, or validate any user-supplied password itself.
5. THE Auth_System SHALL exclude user-supplied passwords from response bodies, URLs, logs, and client-readable storage beyond the in-flight submission to Supabase_Auth.
### Requirement 13: Email/password signup via Supabase

**User Story:** As a user, I want to sign up with my email and a password, so that I can access ContextGraph without a Google account.

#### Acceptance Criteria

1. WHEN a user submits email/password signup, THE Auth_System SHALL create the account by calling `supabase.auth.signUp` with the submitted Email_Password_Credentials.
2. THE Auth_System SHALL delegate password storage, hashing, and verification to Supabase_Auth and SHALL NOT store, hash, persist, or validate the submitted password itself.
3. WHEN `supabase.auth.signUp` succeeds AND email confirmation is required, THE Auth_System SHALL rely on Supabase_Auth to send the Email_Verification message.
4. IF `supabase.auth.signUp` fails, THEN THE Auth_System SHALL reject signup with an error and SHALL NOT grant application access.
5. THE Auth_System SHALL NOT implement a custom password-storage, password-hashing, or credential-verification mechanism as part of signup.

### Requirement 14: Email verification handled by Supabase

**User Story:** As a user, I want my email verified through Supabase, so that my account is confirmed before I gain access.

#### Acceptance Criteria

1. WHEN the server receives an email-confirmation callback, THE Auth_System SHALL complete Email_Verification server-side by processing the Supabase-issued verification token hash or code through the supported Supabase method.
2. THE Auth_System SHALL rely on Supabase_Auth to issue, validate, and expire the Email_Verification token hash or code.
3. IF email confirmation is required AND the user's email is unverified, THEN THE Auth_System SHALL NOT grant usable application access to that user.
4. IF the email-confirmation callback carries an invalid or expired verification token hash or code, THEN THE Auth_System SHALL reject verification with an error and SHALL NOT grant application access.
5. THE Auth_System SHALL NOT implement a custom email-verification token issuance or validation mechanism.
6. IF `supabase.auth.signUp` succeeds AND email confirmation is required AND the Email_Verification message send fails, THEN THE Auth_System SHALL detect the failed send and SHALL surface the failure to the user OR retry the Email_Verification message send.

### Requirement 15: Email/password login via Supabase

**User Story:** As a registered user, I want to log in with my email and password, so that I can resume my work with the same session behavior as Google sign-in.

#### Acceptance Criteria

1. WHEN a user submits email/password login, THE Auth_System SHALL authenticate the user by calling `supabase.auth.signInWithPassword` with the submitted Email_Password_Credentials.
2. WHEN `supabase.auth.signInWithPassword` succeeds, THE Auth_System SHALL establish the same Supabase session and auth cookies through the SSR_Client as the Google sign-in path.
3. IF `supabase.auth.signInWithPassword` rejects the submitted Email_Password_Credentials, THEN THE Auth_System SHALL return a generic authentication error that does not reveal whether the email or the password was incorrect.
4. THE Auth_System SHALL rely on Supabase_Auth to verify the submitted password and SHALL NOT verify the password itself.
5. IF `supabase.auth.signInWithPassword` fails, THEN THE Auth_System SHALL NOT grant application access.

### Requirement 16: Forgot password without account enumeration

**User Story:** As a user who forgot my password, I want to request a reset email, so that I can regain access without revealing whether an account exists.

#### Acceptance Criteria

1. WHEN a user submits a forgot-password request with an email, THE Auth_System SHALL request the reset email by calling `supabase.auth.resetPasswordForEmail` with the submitted email.
2. THE Auth_System SHALL return a response that does not reveal whether a Supabase account exists for the submitted email.
3. WHEN the forgot-password request is submitted for an email with no account AND for an email with an account, THE Auth_System SHALL return responses that are indistinguishable with respect to account existence.
4. THE Auth_System SHALL rely on Supabase_Auth to generate, send, and expire the Password_Reset email and its token.

### Requirement 17: Password reset via recovery session

**User Story:** As a user with a reset link, I want to set a new password securely, so that I can recover access to my account.

#### Acceptance Criteria

1. WHEN the server receives a recovery callback from a Password_Reset link, THE Auth_System SHALL establish the Recovery_Session server-side through the supported Supabase method.
2. WHILE the Recovery_Session is established, THE Auth_System SHALL allow the user to set a new password by calling `supabase.auth.updateUser` with the new password.
3. THE Auth_System SHALL rely on Supabase_Auth to treat the Password_Reset token or code as single-use.
4. IF the recovery callback carries an invalid, expired, or already-used Password_Reset token or code, THEN THE Auth_System SHALL reject the reset with an error and SHALL NOT establish the Recovery_Session.
5. THE Auth_System SHALL handle the Password_Reset token or code server-side and SHALL NOT implement a custom reset-token issuance or validation mechanism.

### Requirement 18: Authenticated password change and set-password

**User Story:** As an authenticated user, I want to change my password or set an initial password, so that I can manage my credentials even if I signed up through Google.

#### Acceptance Criteria

1. WHEN an authenticated user submits a password change, THE Auth_System SHALL update the password by calling `supabase.auth.updateUser` with the new password.
2. WHERE an authenticated user signed up through Google and has no password set, THE Auth_System SHALL present the operation as "Set Password" and SHALL set the initial password by calling `supabase.auth.updateUser`.
3. THE Auth_System SHALL rely on Supabase_Auth to store and manage the changed or newly set password and SHALL NOT store, hash, or validate the password itself.
4. IF `supabase.auth.updateUser` fails, THEN THE Auth_System SHALL report an error and SHALL NOT change the user's credential state.

### Requirement 19: Logout via Supabase sign-out

**User Story:** As an authenticated user, I want to log out, so that my session is cleared and can no longer be used.

#### Acceptance Criteria

1. WHEN an authenticated user logs out, THE Auth_System SHALL end the session by calling `supabase.auth.signOut`.
2. THE Auth_System SHALL clear the Supabase session cookies exclusively through the SSR_Client cookie handler interface, consistent with Supabase controlling auth cookies.
3. IF `supabase.auth.signOut` succeeds WHILE server-held session state fails to invalidate, THEN THE Auth_System SHALL report logout as failed or incomplete until server-held session state is confirmed invalidated so that subsequent requests presenting the cleared session are treated as unauthenticated.
4. THE Auth_System SHALL NOT clear or modify Supabase auth cookies manually outside the SSR_Client cookie handler interface during logout.

### Requirement 20: Authentication screens and server-side callback states

**User Story:** As a user, I want screens for every authentication action and server-handled callbacks, so that I can complete each flow reliably.

#### Acceptance Criteria

1. THE Auth_System SHALL provide an Auth_Screen for login that supports both Google sign-in and email/password login.
2. THE Auth_System SHALL provide Auth_Screens for signup, forgot-password, reset-password, and set/change-password.
3. THE Auth_System SHALL provide an Auth_Screen that presents the Email_Verification result.
4. WHEN the server receives the OAuth callback, the email-confirmation callback, or the recovery callback, THE Auth_System SHALL process each callback state server-side.
5. WHERE a callback state processes a Supabase authorization code, verification token hash, or recovery token, THE Auth_System SHALL complete the exchange through the supported Supabase method via the SSR_Client.

### Requirement 21: Unified identity across authentication methods

**User Story:** As a user, I want Google sign-in and email/password for the same email to be the same account, so that my data and identity stay unified without custom merging.

#### Acceptance Criteria

1. WHEN a user authenticates through Google sign-in AND through email/password for the same email address, THE Auth_System SHALL resolve both to the same canonical Supabase_User_Id using Supabase-supported Identity_Unification behavior.
2. WHEN the same email address is used across Google sign-in and email/password authentication, THE Auth_System SHALL rely on Supabase-supported identity behavior to map both authentication methods to one Supabase_User_Id.
3. THE Auth_System SHALL NOT implement custom account-merging logic to unify the two authentication methods.
4. WHERE both authentication methods resolve to the same Supabase_User_Id, THE Auth_System SHALL associate both with the same provisioned User_Profile, Account_Workspace, and Workspace_Membership.

### Requirement 22: Schema readiness for additional workspaces

**User Story:** As a developer, I want the membership schema to be able to support shared or team workspaces later without building that product functionality now, so that future collaboration features are possible without a schema rewrite while this feature stays scoped to personal workspaces.

#### Acceptance Criteria

1. THE Auth_System SHALL model Workspace_Membership so that an Account_Workspace can hold more than one Workspace_Membership, enabling additional shared or team Account_Workspaces to be supported in the future.
2. THE Auth_System SHALL NOT implement shared or team Account_Workspace product functionality as part of this feature, including no user interface for shared or team workspaces and no multi-member workspace flows beyond the user's personal Account_Workspace.
3. WHERE a user authenticates through this feature, THE Auth_System SHALL grant that user a Workspace_Membership only in that user's personal Account_Workspace.
