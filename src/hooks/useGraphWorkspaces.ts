/**
 * Client-side hook for graph workspace management.
 * Handles loading, creation, switching, and legacy import.
 */

"use client";

import { useState, useCallback, useEffect, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GraphWorkspaceListItem = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  node_count: number;
};

export type PersistedNode = {
  id: string;
  position: { x: number; y: number };
  conversationId?: string;
  data: {
    title: string;
    objectType: string;
    description: string;
    provenance: string;
    createdAt: string;
  };
};

export type PersistedEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: {
    type: string;
    explanation: string;
    provenance: string;
    createdAt: string;
  };
};

export type GraphPayload = {
  nodes: PersistedNode[];
  edges: PersistedEdge[];
};

export type GraphConversation = {
  graph_workspace_id: string;
  conversation_id: string;
  source_node_id: string | null;
  created_at: string;
  title?: string;
};

export type HydrationState =
  | { status: "loading" }
  | { status: "hydrated"; graphId: string }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "migrating" };

// ─── Constants ────────────────────────────────────────────────────────────────

const LEGACY_STORAGE_KEY = "contextgraph-manual-dashboard";
const MIGRATION_MARKER_KEY = "contextgraph-dashboard-migrated";
const SELECTED_GRAPH_KEY = "contextgraph-selected-graph";
const LEGACY_BACKUP_KEY = "contextgraph-manual-dashboard-backup";

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGraphWorkspaces() {
  const [workspaces, setWorkspaces] = useState<GraphWorkspaceListItem[]>([]);
  const [activeGraphId, setActiveGraphId] = useState<string | null>(null);
  const [hydrationState, setHydrationState] = useState<HydrationState>({ status: "loading" });
  const [payload, setPayload] = useState<GraphPayload>({ nodes: [], edges: [] });
  const [conversations, setConversations] = useState<GraphConversation[]>([]);
  const [graphName, setGraphName] = useState<string>("");

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedPayloadRef = useRef<string>("");

  // ─── Initial Load ─────────────────────────────────────────────────────────

  useEffect(() => {
    loadWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setHydrationState({ status: "loading" });

    try {
      const res = await fetch("/api/graph-workspaces");
      if (!res.ok) {
        setHydrationState({ status: "error", message: `Failed to load: ${res.status}` });
        return;
      }

      const list: GraphWorkspaceListItem[] = await res.json();
      setWorkspaces(list);

      if (list.length > 0) {
        // Try to restore last-selected graph
        const savedId = localStorage.getItem(SELECTED_GRAPH_KEY);
        const targetId = list.find((w) => w.id === savedId)?.id ?? list[0].id;
        await loadGraph(targetId);
      } else {
        // No workspaces exist — check for legacy data to import
        await attemptLegacyImport();
      }
    } catch (err) {
      setHydrationState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }, []);

  // ─── Load a specific graph ────────────────────────────────────────────────

  const loadGraph = useCallback(async (graphId: string) => {
    setHydrationState({ status: "loading" });

    try {
      const res = await fetch(`/api/graph-workspaces/${graphId}/load`);
      if (!res.ok) {
        setHydrationState({ status: "error", message: `Failed to load graph: ${res.status}` });
        return;
      }

      const data = await res.json();
      const graphPayload = data.graph_payload as GraphPayload;

      setActiveGraphId(graphId);
      setPayload(graphPayload);
      setConversations(data.conversations || []);
      setGraphName(data.name || "");
      setHydrationState({ status: "hydrated", graphId });
      lastSavedPayloadRef.current = JSON.stringify(graphPayload);

      // Remember selection
      localStorage.setItem(SELECTED_GRAPH_KEY, graphId);
    } catch (err) {
      setHydrationState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }, []);

  // ─── Legacy Import ────────────────────────────────────────────────────────

  const attemptLegacyImport = useCallback(async () => {
    // Check if already migrated
    const migrated = localStorage.getItem(MIGRATION_MARKER_KEY);
    if (migrated === "true") {
      setHydrationState({ status: "empty" });
      return;
    }

    // Check localStorage for legacy data
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      setHydrationState({ status: "empty" });
      return;
    }

    let legacyData: { nodes?: unknown[]; edges?: unknown[] };
    try {
      legacyData = JSON.parse(raw);
    } catch {
      setHydrationState({ status: "empty" });
      return;
    }

    const nodes = legacyData.nodes || [];
    const edges = legacyData.edges || [];

    if (nodes.length === 0 && edges.length === 0) {
      // Empty legacy data — mark as migrated, nothing to import
      localStorage.setItem(MIGRATION_MARKER_KEY, "true");
      setHydrationState({ status: "empty" });
      return;
    }

    setHydrationState({ status: "migrating" });

    try {
      const res = await fetch("/api/graph-workspaces/import-legacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes, edges, source: "localStorage" }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setHydrationState({
          status: "error",
          message: `Import failed: ${(errData as { error?: string }).error || res.status}`,
        });
        return;
      }

      const importResult = await res.json();

      // Verify the import by loading workspaces again
      const verifyRes = await fetch("/api/graph-workspaces");
      if (!verifyRes.ok) {
        setHydrationState({ status: "error", message: "Import verification failed" });
        return;
      }

      const verifiedList: GraphWorkspaceListItem[] = await verifyRes.json();
      const importedGraph = verifiedList.find((w) => w.id === importResult.graphId);

      if (!importedGraph) {
        setHydrationState({ status: "error", message: "Import verification failed: graph not found" });
        return;
      }

      // Success — backup legacy data and mark migration complete.
      // We KEEP the original localStorage key intact during the transition period
      // so that setting NEXT_PUBLIC_GRAPH_WORKSPACES=false restores the old dashboard
      // without manual intervention. The migration marker (not absence of localStorage)
      // determines whether import has already occurred.
      localStorage.setItem(LEGACY_BACKUP_KEY, raw);
      localStorage.setItem(MIGRATION_MARKER_KEY, "true");
      // Do NOT remove LEGACY_STORAGE_KEY — it remains for rollback.

      setWorkspaces(verifiedList);
      await loadGraph(importResult.graphId);
    } catch (err) {
      setHydrationState({
        status: "error",
        message: err instanceof Error ? err.message : "Import failed",
      });
    }
  }, [loadGraph]);

  // ─── Save (debounced) ─────────────────────────────────────────────────────

  const savePayload = useCallback(
    (newPayload: GraphPayload) => {
      if (hydrationState.status !== "hydrated") return;

      setPayload(newPayload);

      // Debounce the actual API call
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        const serialized = JSON.stringify(newPayload);
        if (serialized === lastSavedPayloadRef.current) return;

        try {
          const res = await fetch(`/api/graph-workspaces/${activeGraphId}/save`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodes: newPayload.nodes, edges: newPayload.edges }),
          });
          if (res.ok) {
            lastSavedPayloadRef.current = serialized;
          } else {
            console.error("[useGraphWorkspaces] Save failed:", res.status);
          }
        } catch (err) {
          console.error("[useGraphWorkspaces] Save error:", err);
        }
      }, 400);
    },
    [hydrationState, activeGraphId],
  );

  // Flush pending save on unmount / window close
  useEffect(() => {
    const flush = () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        // Use fetch with keepalive for reliable delivery during page unload
        if (activeGraphId && hydrationState.status === "hydrated") {
          const serialized = JSON.stringify(payload);
          if (serialized !== lastSavedPayloadRef.current) {
            fetch(`/api/graph-workspaces/${activeGraphId}/save`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ nodes: payload.nodes, edges: payload.edges }),
              keepalive: true,
            }).catch(() => { /* best effort */ });
          }
        }
      }
    };

    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [activeGraphId, hydrationState, payload]);

  // ─── CRUD Operations ──────────────────────────────────────────────────────

  const createGraph = useCallback(async (name: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/graph-workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return null;

      const data = await res.json();
      // Reload workspace list and switch to new graph
      const listRes = await fetch("/api/graph-workspaces");
      if (listRes.ok) {
        setWorkspaces(await listRes.json());
      }
      await loadGraph(data.id);
      return data.id;
    } catch {
      return null;
    }
  }, [loadGraph]);

  const renameGraph = useCallback(async (id: string, name: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/graph-workspaces", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      if (!res.ok) return false;

      setWorkspaces((prev) =>
        prev.map((w) => (w.id === id ? { ...w, name } : w)),
      );
      if (id === activeGraphId) setGraphName(name);
      return true;
    } catch {
      return false;
    }
  }, [activeGraphId]);

  const deleteGraph = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/graph-workspaces", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return false;

      const remaining = workspaces.filter((w) => w.id !== id);
      setWorkspaces(remaining);

      if (id === activeGraphId) {
        if (remaining.length > 0) {
          await loadGraph(remaining[0].id);
        } else {
          setActiveGraphId(null);
          setPayload({ nodes: [], edges: [] });
          setConversations([]);
          setGraphName("");
          setHydrationState({ status: "empty" });
        }
      }
      return true;
    } catch {
      return false;
    }
  }, [activeGraphId, workspaces, loadGraph]);

  const switchGraph = useCallback(async (id: string) => {
    if (id === activeGraphId) return;
    await loadGraph(id);
  }, [activeGraphId, loadGraph]);

  // ─── Conversation operations ──────────────────────────────────────────────

  const addConversation = useCallback(async (
    conversationId: string,
    sourceNodeId?: string,
  ): Promise<boolean> => {
    if (!activeGraphId) return false;
    try {
      const res = await fetch("/api/graph-workspaces/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graphId: activeGraphId, conversationId, sourceNodeId }),
      });
      if (!res.ok) return false;

      // Refresh conversation list
      const listRes = await fetch(`/api/graph-workspaces/conversations?graphId=${activeGraphId}`);
      if (listRes.ok) {
        setConversations(await listRes.json());
      }
      return true;
    } catch {
      return false;
    }
  }, [activeGraphId]);

  const removeConversation = useCallback(async (conversationId: string): Promise<boolean> => {
    if (!activeGraphId) return false;
    try {
      const res = await fetch("/api/graph-workspaces/conversations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graphId: activeGraphId, conversationId }),
      });
      if (!res.ok) return false;

      setConversations((prev) =>
        prev.filter((c) => c.conversation_id !== conversationId),
      );
      return true;
    } catch {
      return false;
    }
  }, [activeGraphId]);

  return {
    // State
    workspaces,
    activeGraphId,
    hydrationState,
    payload,
    conversations,
    graphName,

    // Graph operations
    createGraph,
    renameGraph,
    deleteGraph,
    switchGraph,
    loadGraph,
    savePayload,

    // Conversation operations
    addConversation,
    removeConversation,

    // Re-attempt
    retry: loadWorkspaces,
  };
}
