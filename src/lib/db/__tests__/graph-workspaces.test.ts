/**
 * Graph Workspaces lifecycle tests.
 *
 * These test the DB layer logic in isolation by mocking the Supabase client.
 * Tests cover the critical behaviors specified in the migration plan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listGraphWorkspaces,
  createGraphWorkspace,
  importLegacyGraphWorkspace,
  renameGraphWorkspace,
  saveGraphWorkspacePayload,
  deleteGraphWorkspace,
  addConversationToGraph,
  removeConversationFromGraph,
  listGraphConversations,
  unlinkNodeFromConversations,
  getConversationNodePositions,
  saveConversationNodePositions,
  type GraphPayloadV1,
} from "../graph-workspaces";

// ─── Supabase mock ──────────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/src/lib/supabase/server", () => ({
  createServerSupabaseClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

// Chainable mock builder for Supabase query API
function chainMock(returnData: unknown = null, returnError: unknown = null) {
  const result = { data: returnData, error: returnError };
  const chain: Record<string, unknown> = {};
  const handler = () => chain;
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.upsert = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  // Make the chain itself thenable for await
  Object.defineProperty(chain, "then", {
    value: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
    writable: true,
    configurable: true,
  });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Graph Workspaces DB Layer", () => {
  describe("listGraphWorkspaces", () => {
    it("returns workspace list ordered by updated_at", async () => {
      const mockData = [
        { id: "g1", name: "Graph A", graph_payload: { nodes: [{ id: "n1" }], edges: [] }, created_at: "2025-01-01", updated_at: "2025-01-02" },
        { id: "g2", name: "Graph B", graph_payload: { nodes: [], edges: [] }, created_at: "2025-01-01", updated_at: "2025-01-01" },
      ];

      const chain = chainMock(mockData);
      mockFrom.mockReturnValue(chain);

      const result = await listGraphWorkspaces("owner");

      expect(mockFrom).toHaveBeenCalledWith("graph_workspaces");
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Graph A");
      expect(result[0].node_count).toBe(1);
      expect(result[1].node_count).toBe(0);
    });
  });

  describe("importLegacyGraphWorkspace — idempotency", () => {
    it("creates new graph workspace on first import", async () => {
      // First call: check existing → not found
      const checkChain = chainMock(null);
      // Second call: insert → returns new workspace
      const insertChain = chainMock({
        id: "new-id",
        workspace_id: "owner",
        name: "Graph Dashboard",
        graph_payload: { nodes: [], edges: [] },
        schema_version: 1,
        legacy_import_key: "localStorage:owner",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? checkChain : insertChain;
      });

      const payload: GraphPayloadV1 = {
        nodes: [{ id: "n1", position: { x: 100, y: 200 }, data: { title: "Test", objectType: "manual_node", description: "", provenance: "USER_CREATED", createdAt: "2025-01-01" } }],
        edges: [],
      };

      const result = await importLegacyGraphWorkspace("owner", "localStorage:owner", payload);

      expect(result.alreadyExisted).toBe(false);
      expect(result.graphWorkspace.id).toBe("new-id");
    });

    it("returns existing graph on retry (idempotent)", async () => {
      const existingWorkspace = {
        id: "existing-id",
        workspace_id: "owner",
        name: "Graph Dashboard",
        graph_payload: { nodes: [{ id: "n1" }], edges: [] },
        schema_version: 1,
        legacy_import_key: "localStorage:owner",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
      };

      const chain = chainMock(existingWorkspace);
      mockFrom.mockReturnValue(chain);

      const result = await importLegacyGraphWorkspace("owner", "localStorage:owner", { nodes: [], edges: [] });

      expect(result.alreadyExisted).toBe(true);
      expect(result.graphWorkspace.id).toBe("existing-id");
    });
  });

  describe("saveGraphWorkspacePayload", () => {
    it("persists node positions as part of payload", async () => {
      const chain = chainMock(null);
      mockFrom.mockReturnValue(chain);

      const payload: GraphPayloadV1 = {
        nodes: [
          { id: "n1", position: { x: 150, y: 250 }, data: { title: "Moved Node", objectType: "manual_node", description: "", provenance: "USER_CREATED", createdAt: "2025-01-01" } },
        ],
        edges: [],
      };

      await saveGraphWorkspacePayload("g1", payload);

      expect(mockFrom).toHaveBeenCalledWith("graph_workspaces");
      expect(chain.update).toHaveBeenCalledWith({ graph_payload: payload });
    });
  });

  describe("deleteGraphWorkspace", () => {
    it("deletes workspace without affecting conversations", async () => {
      const chain = chainMock(null);
      mockFrom.mockReturnValue(chain);

      await deleteGraphWorkspace("g1");

      expect(mockFrom).toHaveBeenCalledWith("graph_workspaces");
      expect(chain.delete).toHaveBeenCalled();
      // Conversations table should NOT be touched
      expect(mockFrom).not.toHaveBeenCalledWith("conversations");
    });
  });

  describe("Conversation membership", () => {
    it("addConversationToGraph uses upsert to prevent duplicates", async () => {
      const chain = chainMock(null);
      mockFrom.mockReturnValue(chain);

      await addConversationToGraph("g1", "conv-1", "node-1");

      expect(mockFrom).toHaveBeenCalledWith("graph_workspace_conversations");
      expect(chain.upsert).toHaveBeenCalledWith(
        {
          graph_workspace_id: "g1",
          conversation_id: "conv-1",
          source_node_id: "node-1",
        },
        { onConflict: "graph_workspace_id,conversation_id" },
      );
    });

    it("removeConversationFromGraph only removes the link", async () => {
      const chain = chainMock(null);
      mockFrom.mockReturnValue(chain);

      await removeConversationFromGraph("g1", "conv-1");

      expect(mockFrom).toHaveBeenCalledWith("graph_workspace_conversations");
      expect(chain.delete).toHaveBeenCalled();
      // Conversations table itself is never touched
      expect(mockFrom).not.toHaveBeenCalledWith("conversations");
    });

    it("unlinkNodeFromConversations sets source_node_id to null", async () => {
      const chain = chainMock(null);
      mockFrom.mockReturnValue(chain);

      await unlinkNodeFromConversations("g1", "node-42");

      expect(mockFrom).toHaveBeenCalledWith("graph_workspace_conversations");
      expect(chain.update).toHaveBeenCalledWith({ source_node_id: null });
    });
  });

  describe("Conversation node positions (Knowledge Map)", () => {
    it("getConversationNodePositions returns saved positions", async () => {
      const mockData = [
        { node_id: "obj-a", position_x: 100, position_y: 200 },
        { node_id: "obj-b", position_x: 300, position_y: 400 },
      ];
      const chain = chainMock(mockData);
      mockFrom.mockReturnValue(chain);

      const result = await getConversationNodePositions("conv-1");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ node_id: "obj-a", position_x: 100, position_y: 200 });
    });

    it("saveConversationNodePositions upserts batch", async () => {
      const chain = chainMock(null);
      mockFrom.mockReturnValue(chain);

      await saveConversationNodePositions("conv-1", [
        { nodeId: "obj-a", x: 150, y: 250 },
        { nodeId: "obj-b", x: 350, y: 450 },
      ]);

      expect(mockFrom).toHaveBeenCalledWith("conversation_node_positions");
      expect(chain.upsert).toHaveBeenCalled();
      const upsertCall = (chain.upsert as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(upsertCall[0]).toHaveLength(2);
      expect(upsertCall[0][0].node_id).toBe("obj-a");
      expect(upsertCall[0][0].position_x).toBe(150);
      expect(upsertCall[1]).toEqual({ onConflict: "conversation_id,node_id" });
    });

    it("saveConversationNodePositions skips empty array", async () => {
      await saveConversationNodePositions("conv-1", []);
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe("Graph isolation", () => {
    it("creating two graphs produces independent entities", async () => {
      const workspaces: Array<{ id: string; graph_payload: GraphPayloadV1 }> = [];

      mockFrom.mockImplementation(() => {
        const chain = chainMock(null);
        chain.insert = vi.fn().mockImplementation((data: unknown) => {
          const record = data as Record<string, unknown>;
          const ws = { id: crypto.randomUUID(), ...record };
          workspaces.push(ws as unknown as { id: string; graph_payload: GraphPayloadV1 });
          const result = { data: ws, error: null };
          return { ...chain, single: vi.fn().mockResolvedValue(result) };
        });
        return chain;
      });

      await createGraphWorkspace("owner", "Graph A");
      await createGraphWorkspace("owner", "Graph B");

      expect(workspaces).toHaveLength(2);
      expect(workspaces[0].id).not.toBe(workspaces[1].id);
    });
  });
});
