/**
 * Pure in-memory relational-dataset transform model of the UUID_Migration.
 *
 * Feature: google-oauth-authentication (Task 15.3–15.6)
 *
 * This models the EXACT semantics of the `migrate_owner_data_to_user` SQL
 * function (migration 20260824000600) against an in-memory relational dataset,
 * so the correctness properties (P5–P8) can be exercised across many generated
 * inputs with NO live Supabase/Postgres.
 *
 * Modeled tables (mirroring the real schema the migration touches + depends on):
 *   - account_workspaces:  { id, ownerUserId, kind: 'personal' | 'shared' }
 *   - graph_workspaces:    { id, workspaceId: 'owner'|'demo'|..., accountWorkspaceId }
 *   - conversations:       { id, legacyWorkspaceId: 'owner'|'demo'|..., accountWorkspaceId }
 *   - graphWorkspaceConversations: { graphWorkspaceId, conversationId }  (join)
 *   - messages / nodes / edges / conversationNodePositions: { id, conversationId }
 *   - migrationRuns:       Set<userId>
 *
 * Reassociation semantics (parent-first, demo-safe, idempotent) exactly match
 * the SQL:
 *   - skip-if-done when a migrationRuns row exists for the target user,
 *   - re-parent graph_workspaces WHERE workspaceId === 'owner' (keep id),
 *   - re-parent conversations WHERE legacyWorkspaceId === 'owner',
 *   - dependents follow by unchanged conversationId / graphWorkspaceId,
 *   - 'demo' rows are never read-for-modification, modified, or moved,
 *   - record completion in migrationRuns.
 */

export type WorkspaceKind = "personal" | "shared";

export interface AccountWorkspace {
  id: string;
  ownerUserId: string;
  kind: WorkspaceKind;
}

export interface GraphWorkspace {
  id: string;
  /** Legacy discriminator: 'owner' | 'demo' | (other). */
  workspaceId: string;
  accountWorkspaceId: string | null;
}

export interface Conversation {
  id: string;
  /** Legacy discriminator: 'owner' | 'demo' | (other). */
  legacyWorkspaceId: string;
  accountWorkspaceId: string | null;
}

export interface GraphConversationLink {
  graphWorkspaceId: string;
  conversationId: string;
}

export interface DependentRow {
  id: string;
  conversationId: string;
}

export interface Dataset {
  accountWorkspaces: AccountWorkspace[];
  graphWorkspaces: GraphWorkspace[];
  conversations: Conversation[];
  graphWorkspaceConversations: GraphConversationLink[];
  messages: DependentRow[];
  nodes: DependentRow[];
  edges: DependentRow[];
  conversationNodePositions: DependentRow[];
  migrationRuns: Set<string>;
}

/** Deep structural clone so the transform never mutates its input. */
export function cloneDataset(d: Dataset): Dataset {
  return {
    accountWorkspaces: d.accountWorkspaces.map((r) => ({ ...r })),
    graphWorkspaces: d.graphWorkspaces.map((r) => ({ ...r })),
    conversations: d.conversations.map((r) => ({ ...r })),
    graphWorkspaceConversations: d.graphWorkspaceConversations.map((r) => ({ ...r })),
    messages: d.messages.map((r) => ({ ...r })),
    nodes: d.nodes.map((r) => ({ ...r })),
    edges: d.edges.map((r) => ({ ...r })),
    conversationNodePositions: d.conversationNodePositions.map((r) => ({ ...r })),
    migrationRuns: new Set(d.migrationRuns),
  };
}

/**
 * Pure transform mirroring `migrate_owner_data_to_user(target_user)`.
 * Returns a NEW dataset; the input is never mutated.
 *
 * @throws Error if the target has no personal account_workspace (mirrors the
 *   SQL RAISE), so callers can assert the provisioning precondition (Req 11.2).
 */
export function migrateOwnerDataToUser(input: Dataset, targetUser: string): Dataset {
  const d = cloneDataset(input);

  // Skip-if-done (Req 11.4).
  if (d.migrationRuns.has(targetUser)) {
    return d;
  }

  // Resolve target personal workspace (must be provisioned — Req 11.2).
  const targetWs = d.accountWorkspaces.find(
    (w) => w.ownerUserId === targetUser && w.kind === "personal",
  );
  if (!targetWs) {
    throw new Error(
      `migrateOwnerDataToUser: no personal account_workspace for user ${targetUser}`,
    );
  }

  // Re-parent graph_workspaces (owner only; keep id; demo excluded) — Req 11.8/11.9.
  for (const g of d.graphWorkspaces) {
    if (g.workspaceId === "owner" && g.accountWorkspaceId !== targetWs.id) {
      g.accountWorkspaceId = targetWs.id;
    }
  }

  // Re-parent conversations (owner only; demo excluded) — Req 11.1.
  for (const c of d.conversations) {
    if (c.legacyWorkspaceId === "owner" && c.accountWorkspaceId !== targetWs.id) {
      c.accountWorkspaceId = targetWs.id;
    }
  }

  // Dependents follow by unchanged ids — no rewrite needed (Req 11.5, 11.10).

  // Record completion (Req 11.4).
  d.migrationRuns.add(targetUser);

  return d;
}
