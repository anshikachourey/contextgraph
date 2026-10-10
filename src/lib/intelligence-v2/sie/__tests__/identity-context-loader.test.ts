/**
 * Tests for the atomic identity-context loader.
 *
 * Verifies:
 * - Successful mapping of RPC response to IdentityGraphStateContext
 * - Graph version validation
 * - Snapshot token/digest validation
 * - Embedding hashes/versions validation
 * - Privacy suppression filtering verification
 * - Failure on partial or invalid context
 * - Backward-compatible GraphStateContext generation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadIdentityContext,
  IdentityContextLoadError,
} from "../identity-context-loader";

// ─── Mock Supabase ──────────────────────────────────────────────────────────

const mockRpc = vi.fn();

vi.mock("@/src/lib/supabase/server", () => ({
  createServerSupabaseClient: () => ({
    rpc: mockRpc,
  }),
}));

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_CONVERSATION_ID = "conv-test-001";

function makeValidRpcResponse(overrides?: Record<string, unknown>) {
  return {
    graph_version: 7,
    snapshot_token: "snap-conv-test-001-v7-1718000000.123",
    snapshot_digest: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", // 32-char hex
    concerns: [
      {
        concern_id: "concern-1",
        identity_summary: "User's programming learning goals",
        display_title: "Learning Programming",
        current_summary: "Currently studying TypeScript",
        status: "ACTIVE",
        canonical_parent_id: null,
        parent_resolution_state: "PARENT_DEFERRED",
        last_active_at: "2024-01-15T10:00:00Z",
        semantic_version: 3,
        merged_into_concern_id: null,
      },
      {
        concern_id: "concern-2",
        identity_summary: "User's music preferences",
        display_title: "Music Preferences",
        current_summary: "Likes art rock",
        status: "DORMANT",
        canonical_parent_id: null,
        parent_resolution_state: "PARENT_DEFERRED",
        last_active_at: "2023-12-01T10:00:00Z",
        semantic_version: 1,
        merged_into_concern_id: null,
      },
    ],
    propositions: [
      {
        proposition_id: "prop-1",
        canonical_meaning: "User wants to learn TypeScript",
        proposition_type: "PREFERENCE",
        speaker_role: "USER",
        semantic_state: "ACTIVE",
        message_seq_start: 1,
        message_seq_end: 1,
        retention_levels: ["DURABLE_PROPOSITION"],
        source_message_ids: ["msg-1"],
      },
    ],
    active_associations: [
      {
        association_id: "assoc-1",
        proposition_id: "prop-1",
        concern_id: "concern-1",
        role: "PRIMARY_OWNER",
        confidence: "HIGH",
        semantic_state: "ACTIVE",
        established_by_packet_id: "pkt-1",
      },
    ],
    normalized_aliases: [
      {
        alias_id: "alias-1",
        concern_id: "concern-1",
        alias_text: "programming",
      },
    ],
    pending_decisions: [
      {
        decision_id: "dec-1",
        stage: "identity_resolution",
        entity_creation_key: "eck-dec-1",
        outcome: "UNRESOLVED",
        lifecycle_state: "pending",
        rationale: "Multiple competing candidates",
        dependency_refs: ["dep-1"],
      },
    ],
    pending_identity_details: [
      {
        detail_id: "detail-1",
        decision_id: "dec-1",
        packet_id: "pkt-2",
        graph_version_analyzed: 6,
        source_resolution_record_id: "rec-1",
        identity_stage_status: "COMPLETED",
        identity_confidence: "MEDIUM",
        sufficiency_stage_status: "COMPLETED",
        sufficiency_confidence: "HIGH",
      },
    ],
    pending_identity_propositions: [
      {
        id: "pip-1",
        decision_id: "dec-1",
        proposition_id: "prop-2",
        ordinal: 0,
      },
    ],
    packet_lineage: [
      {
        packet_id: "pkt-1",
        conversation_id: TEST_CONVERSATION_ID,
        message_seq_start: 1,
        message_seq_end: 2,
        user_grounded_meaning: "User wants to learn programming",
        cohesion_status: "COHESIVE",
        split_from_packet_id: null,
      },
    ],
    concern_embeddings: {
      status: "LOADED",
      embeddings: [
        {
          concern_id: "concern-1",
          embedding: [0.1, 0.2, 0.3, 0.4],
          source_text_hash: "abc123def456",
          embedding_model_version: "text-embedding-3-small-v1",
          graph_version: 7,
          is_current: true,
        },
      ],
    },
    privacy_suppressed_concern_ids: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("loadIdentityContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful loading", () => {
    it("maps a valid RPC response to IdentityGraphStateContext", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);

      expect(result.graphVersion).toBe(7);
      expect(result.snapshotToken).toBe("snap-conv-test-001-v7-1718000000.123");
      expect(result.snapshotDigest).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");

      const ctx = result.identityContext;
      expect(ctx.graph_version).toBe(7);
      expect(ctx.concerns).toHaveLength(2);
      expect(ctx.concerns[0].concern_id).toBe("concern-1");
      expect(ctx.concerns[0].status).toBe("ACTIVE");
      expect(ctx.concerns[1].status).toBe("DORMANT");
      expect(ctx.propositions).toHaveLength(1);
      expect(ctx.active_associations).toHaveLength(1);
      expect(ctx.normalized_aliases).toHaveLength(1);
      expect(ctx.pending_decisions).toHaveLength(1);
      expect(ctx.pending_identity_details).toHaveLength(1);
      expect(ctx.pending_identity_propositions).toHaveLength(1);
      expect(ctx.packet_lineage).toHaveLength(1);
      expect(ctx.privacy_suppressed_concern_ids).toHaveLength(0);
    });

    it("builds backward-compatible GraphStateContext", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);

      const gsc = result.graphStateContext;
      expect(gsc.graph_version).toBe(7);
      expect(gsc.concerns).toHaveLength(2);
      expect(gsc.propositions).toHaveLength(1);
      expect(gsc.active_associations).toHaveLength(1);
      expect(gsc.pending_decisions).toHaveLength(1);
    });

    it("handles UNAVAILABLE embeddings gracefully", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: {
            status: "UNAVAILABLE",
            reason: "embedding_table_not_provisioned",
          },
        }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);

      expect(result.identityContext.concern_embeddings.status).toBe(
        "UNAVAILABLE"
      );
      if (result.identityContext.concern_embeddings.status === "UNAVAILABLE") {
        expect(result.identityContext.concern_embeddings.reason).toBe(
          "embedding_table_not_provisioned"
        );
      }
    });

    it("handles stale embeddings (is_current=false) without failing", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: {
            status: "LOADED",
            embeddings: [
              {
                concern_id: "concern-1",
                embedding: [0.1, 0.2, 0.3],
                source_text_hash: "hash123",
                embedding_model_version: "v1",
                graph_version: 5, // Stale — older than current version 7
                is_current: false,
              },
            ],
          },
        }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);

      expect(result.identityContext.concern_embeddings.status).toBe("LOADED");
      if (result.identityContext.concern_embeddings.status === "LOADED") {
        expect(
          result.identityContext.concern_embeddings.embeddings[0].is_current
        ).toBe(false);
        expect(
          result.identityContext.concern_embeddings.embeddings[0].graph_version
        ).toBe(5);
      }
    });

    it("passes the correct conversation ID to the RPC", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      await loadIdentityContext(TEST_CONVERSATION_ID);

      expect(mockRpc).toHaveBeenCalledWith("v2_load_sie_identity_context", {
        p_conversation_id: TEST_CONVERSATION_ID,
      });
    });

    it("maps packet lineage with split origin", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          packet_lineage: [
            {
              packet_id: "pkt-child-1",
              conversation_id: TEST_CONVERSATION_ID,
              message_seq_start: 1,
              message_seq_end: 1,
              user_grounded_meaning: "Split child packet",
              cohesion_status: "COHESIVE",
              split_from_packet_id: "pkt-original",
            },
          ],
        }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      expect(result.identityContext.packet_lineage[0].split_from_packet_id).toBe(
        "pkt-original"
      );
    });
  });

  describe("RPC failures", () => {
    it("throws IdentityContextLoadError on RPC error", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: "connection refused" },
      });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe("rpc_error");
        expect((e as IdentityContextLoadError).conversationId).toBe(
          TEST_CONVERSATION_ID
        );
      }
    });

    it("throws on null response data", async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe(
          "invalid_response_structure"
        );
      }
    });
  });

  describe("graph version validation", () => {
    it("throws on missing graph_version", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).graph_version;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe(
          "missing_graph_version"
        );
      }
    });

    it("throws on non-numeric graph_version", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({ graph_version: "not_a_number" }),
        error: null,
      });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });
  });

  describe("snapshot token/digest validation", () => {
    it("throws on missing snapshot_token", async () => {
      const response = makeValidRpcResponse({ snapshot_token: "" });

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe("invalid_snapshot");
      }
    });

    it("throws on missing snapshot_digest", async () => {
      const response = makeValidRpcResponse({ snapshot_digest: "" });

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on invalid snapshot_digest format (not 32-char hex)", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({ snapshot_digest: "too-short" }),
        error: null,
      });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe("invalid_snapshot");
      }
    });

    it("accepts valid 32-char hex digest", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          snapshot_digest: "0123456789abcdef0123456789abcdef",
        }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      expect(result.snapshotDigest).toBe("0123456789abcdef0123456789abcdef");
    });
  });

  describe("partial context validation", () => {
    it("throws on missing concerns array", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).concerns;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe("partial_context");
      }
    });

    it("throws on missing propositions array", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).propositions;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe("partial_context");
      }
    });

    it("throws on missing active_associations array", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).active_associations;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on missing normalized_aliases array", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).normalized_aliases;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on missing pending_decisions array", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).pending_decisions;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on missing packet_lineage array", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).packet_lineage;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });
  });

  describe("embedding validation", () => {
    it("throws on missing concern_embeddings", async () => {
      const response = makeValidRpcResponse();
      delete (response as Record<string, unknown>).concern_embeddings;

      mockRpc.mockResolvedValueOnce({ data: response, error: null });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe(
          "invalid_embeddings"
        );
      }
    });

    it("throws on LOADED status with missing embeddings array", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: { status: "LOADED" },
        }),
        error: null,
      });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on unknown embedding status", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: { status: "UNKNOWN_STATUS" },
        }),
        error: null,
      });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on embedding with missing source_text_hash", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: {
            status: "LOADED",
            embeddings: [
              {
                concern_id: "concern-1",
                embedding: [0.1, 0.2],
                source_text_hash: "",
                embedding_model_version: "v1",
                graph_version: 7,
                is_current: true,
              },
            ],
          },
        }),
        error: null,
      });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe(
          "invalid_embeddings"
        );
      }
    });

    it("throws on embedding with missing embedding_model_version", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: {
            status: "LOADED",
            embeddings: [
              {
                concern_id: "concern-1",
                embedding: [0.1, 0.2],
                source_text_hash: "hash123",
                embedding_model_version: "",
                graph_version: 7,
                is_current: true,
              },
            ],
          },
        }),
        error: null,
      });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });

    it("throws on embedding with empty embedding vector", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concern_embeddings: {
            status: "LOADED",
            embeddings: [
              {
                concern_id: "concern-1",
                embedding: [],
                source_text_hash: "hash123",
                embedding_model_version: "v1",
                graph_version: 7,
                is_current: true,
              },
            ],
          },
        }),
        error: null,
      });

      await expect(loadIdentityContext(TEST_CONVERSATION_ID)).rejects.toThrow(
        IdentityContextLoadError
      );
    });
  });

  describe("privacy suppression validation", () => {
    it("throws when a suppressed concern leaks into concerns array", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concerns: [
            {
              concern_id: "suppressed-concern",
              identity_summary: "Should not be here",
              display_title: "Suppressed",
              current_summary: "This is private",
              status: "ACTIVE",
              canonical_parent_id: null,
              parent_resolution_state: "PARENT_DEFERRED",
              last_active_at: "2024-01-01T00:00:00Z",
              semantic_version: 1,
            },
          ],
          privacy_suppressed_concern_ids: ["suppressed-concern"],
        }),
        error: null,
      });

      try {
        await loadIdentityContext(TEST_CONVERSATION_ID);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(IdentityContextLoadError);
        expect((e as IdentityContextLoadError).reason).toBe(
          "suppression_violation"
        );
      }
    });

    it("passes when suppressed IDs are not in concerns array", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          privacy_suppressed_concern_ids: ["concern-that-was-removed"],
        }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      expect(result.identityContext.privacy_suppressed_concern_ids).toEqual([
        "concern-that-was-removed",
      ]);
    });

    it("handles empty suppression list", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({ privacy_suppressed_concern_ids: [] }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      expect(result.identityContext.privacy_suppressed_concern_ids).toEqual([]);
    });
  });

  describe("data mapping correctness", () => {
    it("maps concern fields correctly", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      const concern = result.identityContext.concerns[0];

      expect(concern.concern_id).toBe("concern-1");
      expect(concern.identity_summary).toBe(
        "User's programming learning goals"
      );
      expect(concern.display_title).toBe("Learning Programming");
      expect(concern.current_summary).toBe("Currently studying TypeScript");
      expect(concern.status).toBe("ACTIVE");
      expect(concern.canonical_parent_id).toBeNull();
      expect(concern.parent_resolution_state).toBe("PARENT_DEFERRED");
      expect(concern.last_active_at).toBe("2024-01-15T10:00:00Z");
      expect(concern.semantic_version).toBe(3);
    });

    it("maps proposition fields correctly", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      const prop = result.identityContext.propositions[0];

      expect(prop.proposition_id).toBe("prop-1");
      expect(prop.canonical_meaning).toBe("User wants to learn TypeScript");
      expect(prop.proposition_type).toBe("PREFERENCE");
      expect(prop.speaker_role).toBe("USER");
      expect(prop.semantic_state).toBe("ACTIVE");
      expect(prop.message_seq_range).toEqual([1, 1]);
    });

    it("maps pending identity details correctly", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      const detail = result.identityContext.pending_identity_details[0];

      expect(detail.detail_id).toBe("detail-1");
      expect(detail.decision_id).toBe("dec-1");
      expect(detail.packet_id).toBe("pkt-2");
      expect(detail.graph_version_analyzed).toBe(6);
      expect(detail.source_resolution_record_id).toBe("rec-1");
      expect(detail.identity_stage_status).toBe("COMPLETED");
      expect(detail.identity_confidence).toBe("MEDIUM");
      expect(detail.sufficiency_stage_status).toBe("COMPLETED");
      expect(detail.sufficiency_confidence).toBe("HIGH");
    });

    it("maps pending decisions with dependency_refs", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse(),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);
      const dec = result.identityContext.pending_decisions[0];

      expect(dec.decision_id).toBe("dec-1");
      expect(dec.stage).toBe("identity_resolution");
      expect(dec.entity_creation_key).toBe("eck-dec-1");
      expect(dec.outcome).toBe("UNRESOLVED");
      expect(dec.lifecycle_state).toBe("pending");
      expect(dec.rationale).toBe("Multiple competing candidates");
      expect(dec.dependency_refs).toEqual(["dep-1"]);
    });

    it("maps empty arrays correctly", async () => {
      mockRpc.mockResolvedValueOnce({
        data: makeValidRpcResponse({
          concerns: [],
          propositions: [],
          active_associations: [],
          normalized_aliases: [],
          pending_decisions: [],
          pending_identity_details: [],
          pending_identity_propositions: [],
          packet_lineage: [],
          concern_embeddings: {
            status: "LOADED",
            embeddings: [],
          },
        }),
        error: null,
      });

      const result = await loadIdentityContext(TEST_CONVERSATION_ID);

      expect(result.identityContext.concerns).toEqual([]);
      expect(result.identityContext.propositions).toEqual([]);
      expect(result.identityContext.active_associations).toEqual([]);
      expect(result.identityContext.normalized_aliases).toEqual([]);
      expect(result.identityContext.pending_decisions).toEqual([]);
      expect(result.identityContext.pending_identity_details).toEqual([]);
      expect(result.identityContext.pending_identity_propositions).toEqual([]);
      expect(result.identityContext.packet_lineage).toEqual([]);
    });
  });
});
