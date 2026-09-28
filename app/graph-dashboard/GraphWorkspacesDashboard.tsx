"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  SelectionMode,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Connection,
  type OnSelectionChangeParams,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import V2NodeCard, { type V2FlowNode } from "@/src/components/graph-v2/V2NodeCard";
import {
  copyNodesToClipboard,
  preparePaste,
  hasClipboardContent,
  type CopyableNode,
  type CopyableEdge,
} from "@/src/lib/graph-clipboard";
import {
  useGraphWorkspaces,
  type PersistedNode,
  type PersistedEdge,
  type GraphPayload,
} from "@/src/hooks/useGraphWorkspaces";

// Use the same custom node type as the Full Network graph
const nodeTypes = { v2Node: V2NodeCard };

// ---------------------------------------------------------------------------
// GraphSidebarItem — expandable graph with nested conversations
// ---------------------------------------------------------------------------

type SidebarConversation = { conversation_id: string; title?: string; source_node_id: string | null };

function GraphSidebarItem({
  graph,
  isActive,
  conversations,
  selectedConversationId,
  onSelectGraph,
  onSelectConversation,
  onRemoveConversation,
}: {
  graph: { id: string; name: string; node_count: number };
  isActive: boolean;
  conversations: SidebarConversation[];
  selectedConversationId: string | null;
  onSelectGraph: () => void;
  onSelectConversation: (conversationId: string, graphId: string, sourceNodeId: string | null) => void;
  onRemoveConversation: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(isActive);
  // Lazily-fetched conversations for non-active graphs.
  const [lazyConversations, setLazyConversations] = useState<SidebarConversation[] | null>(null);
  const [loadingLazy, setLoadingLazy] = useState(false);
  // Guards against duplicate/self-cancelling fetches across effect re-runs.
  const fetchStartedRef = useRef(false);

  // Auto-expand when this graph becomes active
  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  // When a non-active graph is expanded, fetch its conversations on demand.
  useEffect(() => {
    if (!expanded || isActive) return;
    if (fetchStartedRef.current) return;

    fetchStartedRef.current = true;
    setLoadingLazy(true);
    fetch(`/api/graph-workspaces/conversations?graphId=${graph.id}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: SidebarConversation[]) => {
        setLazyConversations(data || []);
      })
      .catch(() => {
        setLazyConversations([]);
      })
      .finally(() => {
        setLoadingLazy(false);
      });
  }, [expanded, isActive, graph.id]);

  // If this graph becomes active, reset the lazy cache so it uses the live prop
  // and re-fetches fresh next time it's collapsed/expanded as non-active.
  useEffect(() => {
    if (isActive) {
      fetchStartedRef.current = false;
      setLazyConversations(null);
    }
  }, [isActive]);

  // Active graph uses the live `conversations` prop; others use the lazy fetch.
  const displayConversations = isActive ? conversations : (lazyConversations ?? []);

  return (
    <div className="rounded-lg">
      {/* Graph row */}
      <div className={`flex items-center rounded-lg transition-colors ${isActive ? "bg-[var(--accent-light)]" : "hover:bg-[var(--muted)]"}`}>
        {/* Disclosure toggle — click does NOT open the graph */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        {/* Graph name — click opens the graph canvas */}
        <button
          onClick={onSelectGraph}
          className={`flex flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-[13px] font-medium truncate ${isActive ? "text-[var(--accent)]" : "text-[var(--foreground)]"}`}
        >
          {/* Graph icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><circle cx="5" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="19" cy="6" r="2" /><path d="M5 8v6a2 2 0 002 2h3M19 8v4M14 18h3a2 2 0 002-2M7 6h10" /></svg>
          <span className="truncate">{graph.name}</span>
        </button>
      </div>

      {/* Nested conversations (when expanded) */}
      {expanded && displayConversations.length > 0 && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
          {displayConversations.map((c) => {
            const isConvSelected = c.conversation_id === selectedConversationId;
            return (
            <div
              key={c.conversation_id}
              className={`group flex items-center rounded-md transition-colors ${isConvSelected ? "bg-[var(--accent-light)]" : "hover:bg-[var(--muted)]"}`}
            >
              <button
                onClick={() => onSelectConversation(c.conversation_id, graph.id, c.source_node_id)}
                className={`flex flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-[12px] ${isConvSelected ? "font-medium text-[var(--accent)]" : "text-[var(--foreground)]"}`}
              >
                {/* Conversation icon with subtle accent tint for graph-scoped */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" className="shrink-0 opacity-60"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                <span className="truncate">{c.title || "Untitled"}</span>
              </button>
              <button
                onClick={() => onRemoveConversation(c.conversation_id)}
                className="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-all hover:text-red-600 group-hover:opacity-100"
                title="Remove from graph"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            );
          })}
        </div>
      )}

      {expanded && displayConversations.length === 0 && (
        <div className="ml-4 mt-0.5 border-l border-[var(--border)] pl-2">
          <p className="px-2 py-1.5 text-[11px] text-[var(--muted-foreground)]">
            {loadingLazy ? "Loading…" : "No conversations yet"}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convert between persisted format and React Flow format
// ---------------------------------------------------------------------------

function persistedToFlowNode(n: PersistedNode, selectedId: string | null): V2FlowNode {
  return {
    id: n.id,
    type: "v2Node",
    position: n.position,
    data: {
      title: n.data.title,
      objectType: n.data.objectType || "manual_node",
      description: n.data.description || "",
      maturity: "established",
      status: "active",
      propositionCount: 0,
      depth: 0,
      hasOverlap: false,
      isSelected: n.id === selectedId,
    },
  };
}

function persistedToFlowEdge(e: PersistedEdge): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "default",
    label: e.label || e.data?.type?.replace(/_/g, " ") || undefined,
    labelStyle: { fontSize: 9, fill: "#94a3b8" },
    labelBgStyle: { fill: "#f8fafc", stroke: "#e2e8f0", strokeWidth: 0.5 },
    labelBgPadding: [4, 2] as [number, number],
    style: { stroke: "#334155", strokeWidth: 2, opacity: 0.85 },
    data: e.data,
  };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function GraphWorkspacesDashboard() {
  // ─── Graph workspace state ──────────────────────────────────────────────
  const {
    workspaces,
    activeGraphId,
    hydrationState,
    payload,
    conversations,
    graphName,
    createGraph,
    renameGraph,
    deleteGraph,
    switchGraph,
    savePayload,
    addConversation,
    removeConversation,
    retry,
  } = useGraphWorkspaces();

  // ─── UI state ──────────────────────────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [showEdgeModal, setShowEdgeModal] = useState(false);
  const [newNodeTitle, setNewNodeTitle] = useState("");
  const [newNodeDescription, setNewNodeDescription] = useState("");
  const [newEdgeLabel, setNewEdgeLabel] = useState("");
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [panOnDrag, setPanOnDrag] = useState(true);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const [selectedFlowNodes, setSelectedFlowNodes] = useState<V2FlowNode[]>([]);
  const [showEditNodeModal, setShowEditNodeModal] = useState(false);
  const [editNodeTitle, setEditNodeTitle] = useState("");
  const [editNodeDescription, setEditNodeDescription] = useState("");
  const [showEditEdgeModal, setShowEditEdgeModal] = useState(false);
  const [editEdgeLabel, setEditEdgeLabel] = useState("");
  const [showDeleteEdgeConfirm, setShowDeleteEdgeConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showGraphSelector, setShowGraphSelector] = useState(false);
  const [showNewGraphModal, setShowNewGraphModal] = useState(false);
  const [newGraphName, setNewGraphName] = useState("");
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showDeleteGraphConfirm, setShowDeleteGraphConfirm] = useState(false);
  const [showConversationsSidebar, setShowConversationsSidebar] = useState(true);
  const [showAddConversationModal, setShowAddConversationModal] = useState(false);
  const [availableConversations, setAvailableConversations] = useState<Array<{ id: string; title: string }>>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  // In-dashboard chat overlay: holds the conversation id currently open inside the dashboard
  const [openChatConversationId, setOpenChatConversationId] = useState<string | null>(null);
  // Right-panel selection for a node-less conversation (independent conversation
  // added to the graph that has no originating node to highlight).
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  // When a cross-graph conversation is clicked, we switch graphs first and defer
  // the node/conversation selection until the new graph has hydrated.
  const pendingConversationSelectionRef = useRef<{ conversationId: string; sourceNodeId: string | null } | null>(null);

  // Current nodes/edges from payload
  const persistedNodes = payload.nodes;
  const persistedEdges = payload.edges;

  // Helper to update payload
  const updatePayload = useCallback((updater: (prev: GraphPayload) => GraphPayload) => {
    const newPayload = updater(payload);
    savePayload(newPayload);
  }, [payload, savePayload]);

  // ─── Derive React Flow state from persisted data ────────────────────────
  const initialFlowNodes: V2FlowNode[] = persistedNodes.map((n) => persistedToFlowNode(n, selectedNodeId));
  const initialFlowEdges: Edge[] = persistedEdges.map(persistedToFlowEdge);

  const [flowNodes, setFlowNodes, onNodesChangeInternal] = useNodesState<V2FlowNode>(initialFlowNodes);
  const [flowEdges, setFlowEdges, onEdgesChangeInternal] = useEdgesState<Edge>(initialFlowEdges);

  // Sync persisted → flow whenever persisted data changes
  useEffect(() => {
    if (hydrationState.status !== "hydrated") return;
    setFlowNodes(persistedNodes.map((n) => persistedToFlowNode(n, selectedNodeId)));
  }, [persistedNodes, selectedNodeId, setFlowNodes, hydrationState.status]);

  useEffect(() => {
    if (hydrationState.status !== "hydrated") return;
    const baseEdges = persistedEdges.map(persistedToFlowEdge);
    if (!selectedEdgeId) {
      setFlowEdges(baseEdges);
    } else {
      setFlowEdges(baseEdges.map((e) =>
        e.id === selectedEdgeId
          ? { ...e, selected: true, animated: true, style: { ...e.style, stroke: "#6366f1", strokeWidth: 3 } }
          : { ...e, selected: false, animated: false }
      ));
    }
  }, [persistedEdges, selectedEdgeId, setFlowEdges, hydrationState.status]);

  // ─── React Flow handlers ────────────────────────────────────────────────
  const onNodesChange: OnNodesChange<V2FlowNode> = useCallback((changes) => {
    if (hydrationState.status !== "hydrated") return;
    onNodesChangeInternal(changes);

    // Persist position changes back to canonical state
    const positionChanges = changes.filter(
      (c) => c.type === "position" && c.position && !c.dragging
    );
    if (positionChanges.length > 0) {
      updatePayload((prev) => {
        const updated = [...prev.nodes];
        for (const change of positionChanges) {
          if (change.type === "position" && change.position) {
            const idx = updated.findIndex((n) => n.id === change.id);
            if (idx >= 0) {
              updated[idx] = { ...updated[idx], position: change.position };
            }
          }
        }
        return { ...prev, nodes: updated };
      });
    }

    // Persist removals
    const removeChanges = changes.filter((c) => c.type === "remove");
    if (removeChanges.length > 0) {
      const removedIds = new Set(removeChanges.map((c) => c.id));
      updatePayload((prev) => ({
        nodes: prev.nodes.filter((n) => !removedIds.has(n.id)),
        edges: prev.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target)),
      }));
    }
  }, [onNodesChangeInternal, hydrationState.status, updatePayload]);

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    if (hydrationState.status !== "hydrated") return;
    onEdgesChangeInternal(changes);

    const removeChanges = changes.filter((c) => c.type === "remove");
    if (removeChanges.length > 0) {
      const removedIds = new Set(removeChanges.map((c) => c.id));
      updatePayload((prev) => ({
        ...prev,
        edges: prev.edges.filter((e) => !removedIds.has(e.id)),
      }));
    }
  }, [onEdgesChangeInternal, hydrationState.status, updatePayload]);

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    setPendingConnection(connection);
    setNewEdgeLabel("");
    setShowEdgeModal(true);
  }, []);

  const onSelectionChange = useCallback(({ nodes: selected }: OnSelectionChangeParams) => {
    setSelectedFlowNodes(selected as V2FlowNode[]);
  }, []);

  // ─── Node CRUD ──────────────────────────────────────────────────────────
  const handleAddNode = useCallback(() => {
    if (!newNodeTitle.trim()) return;
    const newNode: PersistedNode = {
      id: crypto.randomUUID(),
      position: { x: 100 + Math.random() * 400, y: 100 + Math.random() * 300 },
      data: {
        title: newNodeTitle.trim(),
        objectType: "manual_node",
        description: newNodeDescription.trim(),
        provenance: "USER_CREATED",
        createdAt: new Date().toISOString(),
      },
    };
    updatePayload((prev) => ({ ...prev, nodes: [...prev.nodes, newNode] }));
    setNewNodeTitle("");
    setNewNodeDescription("");
    setShowNodeModal(false);
  }, [newNodeTitle, newNodeDescription, updatePayload]);

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId) return;
    updatePayload((prev) => ({
      nodes: prev.nodes.filter((n) => n.id !== selectedNodeId),
      edges: prev.edges.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId),
    }));
    // Unlink node from conversation associations (fire and forget)
    if (activeGraphId) {
      fetch("/api/graph-workspaces/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graphId: activeGraphId, nodeId: selectedNodeId, action: "unlink" }),
      }).catch(() => { /* non-critical */ });
    }
    setSelectedNodeId(null);
  }, [selectedNodeId, updatePayload, activeGraphId]);

  const handleEditNodeSave = useCallback(() => {
    if (!selectedNodeId || !editNodeTitle.trim()) return;
    updatePayload((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === selectedNodeId
          ? { ...n, data: { ...n.data, title: editNodeTitle.trim(), description: editNodeDescription.trim() } }
          : n
      ),
    }));
    setShowEditNodeModal(false);
  }, [selectedNodeId, editNodeTitle, editNodeDescription, updatePayload]);

  const handleDeleteSelected = useCallback(() => {
    const idsToDelete = new Set(
      selectedFlowNodes.length > 0
        ? selectedFlowNodes.map((n) => n.id)
        : selectedNodeId ? [selectedNodeId] : []
    );
    if (idsToDelete.size === 0) return;

    updatePayload((prev) => ({
      nodes: prev.nodes.filter((n) => !idsToDelete.has(n.id)),
      edges: prev.edges.filter((e) => !idsToDelete.has(e.source) && !idsToDelete.has(e.target)),
    }));
    setSelectedNodeId(null);
    setSelectedFlowNodes([]);
    setShowDeleteConfirm(false);
  }, [selectedFlowNodes, selectedNodeId, updatePayload]);

  // ─── Edge CRUD ──────────────────────────────────────────────────────────
  const handleAddEdge = useCallback(() => {
    if (!pendingConnection?.source || !pendingConnection?.target) return;
    const newEdge: PersistedEdge = {
      id: crypto.randomUUID(),
      source: pendingConnection.source,
      target: pendingConnection.target,
      label: newEdgeLabel.trim() || undefined,
      data: {
        type: newEdgeLabel.trim() || "related_to",
        explanation: "",
        provenance: "USER_CREATED",
        createdAt: new Date().toISOString(),
      },
    };
    updatePayload((prev) => ({ ...prev, edges: [...prev.edges, newEdge] }));
    setPendingConnection(null);
    setNewEdgeLabel("");
    setShowEdgeModal(false);
  }, [pendingConnection, newEdgeLabel, updatePayload]);

  const handleDeleteEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    updatePayload((prev) => ({
      ...prev,
      edges: prev.edges.filter((e) => e.id !== selectedEdgeId),
    }));
    setSelectedEdgeId(null);
  }, [selectedEdgeId, updatePayload]);

  const handleEditEdgeSave = useCallback(() => {
    if (!selectedEdgeId) return;
    updatePayload((prev) => ({
      ...prev,
      edges: prev.edges.map((e) =>
        e.id === selectedEdgeId
          ? { ...e, label: editEdgeLabel.trim() || undefined, data: { ...e.data!, type: editEdgeLabel.trim() || "related_to" } }
          : e
      ),
    }));
    setShowEditEdgeModal(false);
  }, [selectedEdgeId, editEdgeLabel, updatePayload]);

  // ─── Conversation from node ─────────────────────────────────────────────
  const handleStartConversation = useCallback(async () => {
    if (!selectedNodeId || !activeGraphId) return;
    const node = persistedNodes.find((n) => n.id === selectedNodeId);
    if (!node || node.conversationId) return;

    try {
      // Create conversation with graph_workspace scope so it doesn't appear in main sidebar
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: node.data.title, scope: "graph_workspace" }),
      });
      if (!res.ok) return;

      const data = await res.json();
      const newConversationId = data.id;
      if (!newConversationId) return;

      // Associate conversation with graph (must succeed for consistency)
      const membershipSuccess = await addConversation(newConversationId, selectedNodeId);
      if (!membershipSuccess) {
        // Membership failed — the conversation exists but is graph-scoped,
        // so it won't leak into the main sidebar. Log and continue.
        console.error("[GraphDashboard] Failed to create graph membership for conversation:", newConversationId);
      }

      // Update node with conversationId
      updatePayload((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === selectedNodeId ? { ...n, conversationId: newConversationId } : n
        ),
      }));

      // Open the chat inside the dashboard (not a separate page)
      setOpenChatConversationId(newConversationId);
    } catch (err) {
      console.error("[GraphDashboard] Failed to start conversation:", err);
    }
  }, [selectedNodeId, activeGraphId, persistedNodes, updatePayload, addConversation]);

  const handleContinueConversation = useCallback(() => {
    if (!selectedNodeId) return;
    const node = persistedNodes.find((n) => n.id === selectedNodeId);
    if (!node?.conversationId) return;
    // Open the chat inside the dashboard (not a separate page)
    setOpenChatConversationId(node.conversationId);
  }, [selectedNodeId, persistedNodes]);

  // Applies the sidebar selection against the CURRENTLY loaded graph payload.
  // Assumes the correct graph is already active/hydrated.
  const applyConversationSelection = useCallback((conversationId: string, sourceNodeId: string | null) => {
    // Prefer the node that directly stores this conversationId in the payload.
    let node = persistedNodes.find((n) => n.conversationId === conversationId);
    let needsBackfill = false;

    // Fall back to the provided/membership source_node_id if the payload link is missing.
    if (!node && sourceNodeId) {
      node = persistedNodes.find((n) => n.id === sourceNodeId);
      needsBackfill = !!node;
    }

    if (node) {
      if (needsBackfill && !node.conversationId) {
        const nodeId = node.id;
        updatePayload((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === nodeId ? { ...n, conversationId } : n
          ),
        }));
      }
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
      setSelectedConversationId(null);
    } else {
      // No originating node in this graph — show the conversation panel.
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setSelectedConversationId(conversationId);
    }
  }, [persistedNodes, updatePayload]);

  // Clicking a conversation in the sidebar does NOT open the chat directly.
  // If the conversation belongs to a different graph, switch to that graph's
  // canvas first, then select/highlight the originating node once it hydrates.
  const handleSelectConversationFromSidebar = useCallback((
    conversationId: string,
    graphId: string,
    sourceNodeId: string | null,
  ) => {
    if (graphId !== activeGraphId) {
      // Cross-graph: switch canvas to that graph, then apply selection after load.
      pendingConversationSelectionRef.current = { conversationId, sourceNodeId };
      switchGraph(graphId);
      return;
    }
    applyConversationSelection(conversationId, sourceNodeId);
  }, [activeGraphId, switchGraph, applyConversationSelection]);

  // Once the pending graph has hydrated, apply the deferred conversation selection.
  useEffect(() => {
    if (hydrationState.status !== "hydrated") return;
    const pending = pendingConversationSelectionRef.current;
    if (!pending) return;
    if (hydrationState.graphId !== activeGraphId) return;
    pendingConversationSelectionRef.current = null;
    applyConversationSelection(pending.conversationId, pending.sourceNodeId);
  }, [hydrationState, activeGraphId, applyConversationSelection]);

  // ─── Selection ──────────────────────────────────────────────────────────
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setSelectedConversationId(null);
  }, []);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
    setSelectedConversationId(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedConversationId(null);
  }, []);

  // ─── Copy / Paste ───────────────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    const toCopy = selectedFlowNodes.length > 0
      ? selectedFlowNodes
      : (selectedNodeId ? flowNodes.filter((n) => n.id === selectedNodeId) : []);
    if (toCopy.length === 0) return;

    const copyableNodes: CopyableNode[] = toCopy.map((n) => ({
      objectId: n.id,
      title: n.data.title,
      description: n.data.description,
      objectType: n.data.objectType,
      provenanceSummary: "USER_CREATED",
      supportingUtteranceIds: [],
      x: n.position?.x,
      y: n.position?.y,
    }));

    const selectedIds = new Set(toCopy.map((n) => n.id));
    const copyableEdges: CopyableEdge[] = persistedEdges
      .filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target))
      .map((e) => ({
        relationshipId: e.id,
        sourceObjectId: e.source,
        targetObjectId: e.target,
        type: e.data?.type || "related_to",
        explanation: e.data?.explanation || "",
      }));

    copyNodesToClipboard(copyableNodes, copyableEdges, "graph-dashboard", "owner");
    try {
      await navigator.clipboard.writeText(toCopy.map((n) => n.data.title).join(", "));
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    } catch { /* */ }
  }, [selectedFlowNodes, selectedNodeId, flowNodes, persistedEdges]);

  const handlePaste = useCallback(() => {
    if (!hasClipboardContent()) return;
    const result = preparePaste(300, 300, "owner");
    if (!result) return;

    const newNodes: PersistedNode[] = result.nodes.map((n) => ({
      id: n.newObjectId,
      position: { x: n.x, y: n.y },
      data: {
        title: n.title,
        objectType: n.objectType,
        description: n.description,
        provenance: "USER_CREATED",
        createdAt: new Date().toISOString(),
      },
    }));

    const newEdges: PersistedEdge[] = result.edges.map((e) => ({
      id: e.newRelationshipId,
      source: e.sourceObjectId,
      target: e.targetObjectId,
      label: e.type !== "related_to" ? e.type : undefined,
      data: {
        type: e.type,
        explanation: e.explanation,
        provenance: "USER_CREATED",
        createdAt: new Date().toISOString(),
      },
    }));

    updatePayload((prev) => ({
      nodes: [...prev.nodes, ...newNodes],
      edges: [...prev.edges, ...newEdges],
    }));
  }, [updatePayload]);

  // ─── Graph workspace actions ────────────────────────────────────────────
  const handleCreateGraph = useCallback(async () => {
    if (!newGraphName.trim()) return;
    await createGraph(newGraphName.trim());
    setNewGraphName("");
    setShowNewGraphModal(false);
    setShowGraphSelector(false);
  }, [newGraphName, createGraph]);

  const handleRenameGraph = useCallback(async () => {
    if (!activeGraphId || !renameValue.trim()) return;
    await renameGraph(activeGraphId, renameValue.trim());
    setShowRenameModal(false);
  }, [activeGraphId, renameValue, renameGraph]);

  const handleDeleteGraph = useCallback(async () => {
    if (!activeGraphId) return;
    await deleteGraph(activeGraphId);
    setShowDeleteGraphConfirm(false);
  }, [activeGraphId, deleteGraph]);

  // ─── Derived state for detail panel ─────────────────────────────────────
  const selectedPersistedNode = selectedNodeId ? persistedNodes.find((n) => n.id === selectedNodeId) : null;
  const selectedPersistedEdge = selectedEdgeId ? persistedEdges.find((e) => e.id === selectedEdgeId) : null;
  const selectedConversation = selectedConversationId
    ? conversations.find((c) => c.conversation_id === selectedConversationId)
    : null;

  // The conversation currently highlighted in the sidebar: either a directly
  // selected (node-less) conversation, or the conversation of the selected node.
  const highlightedConversationId =
    selectedConversationId ?? selectedPersistedNode?.conversationId ?? null;

  // ─── Add existing conversation ─────────────────────────────────────────
  const handleOpenAddConversation = useCallback(async () => {
    setShowAddConversationModal(true);
    setLoadingConversations(true);
    try {
      // Only show main-scoped (independent) conversations as candidates
      const res = await fetch("/api/conversations");
      if (res.ok) {
        const all: Array<{ id: string; title: string }> = await res.json();
        // Filter out conversations already in this graph
        const existingIds = new Set(conversations.map((c) => c.conversation_id));
        setAvailableConversations(all.filter((c) => !existingIds.has(c.id)));
      }
    } catch {
      setAvailableConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }, [conversations]);

  const handleAddExistingConversation = useCallback(async (conversationId: string) => {
    const success = await addConversation(conversationId);
    if (success) {
      // Remove from available list
      setAvailableConversations((prev) => prev.filter((c) => c.id !== conversationId));
    }
  }, [addConversation]);

  // ─── Loading / Error / Empty states ─────────────────────────────────────
  if (hydrationState.status === "loading" || hydrationState.status === "migrating") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--background)]">
        <Spinner
          size="lg"
          label={hydrationState.status === "migrating" ? "Importing your graph data…" : "Loading graphs…"}
        />
      </div>
    );
  }

  if (hydrationState.status === "error") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--background)] px-6">
        <div className="w-full max-w-sm space-y-4">
          <Banner status="error" collapsible={false} title="Failed to load graphs" description={hydrationState.message} />
          <div className="flex justify-center">
            <Button variant="secondary" label="Retry" onClick={retry} />
          </div>
        </div>
      </div>
    );
  }

  if (hydrationState.status === "empty") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[var(--background)]">
        <EmptyState
          title="No graph workspaces yet"
          description="Create your first graph to start organizing knowledge visually."
          actions={<Button variant="primary" label="New Graph" onClick={() => setShowNewGraphModal(true)} />}
        />
        {/* New Graph Modal inline for empty state */}
        {showNewGraphModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowNewGraphModal(false)} />
            <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
              <h2 className="text-[16px] font-semibold text-[var(--foreground)]">New Graph</h2>
              <div className="mt-4">
                <TextInput
                  label="Name"
                  value={newGraphName}
                  onChange={setNewGraphName}
                  onEnter={handleCreateGraph}
                  placeholder="e.g. Career Planning"
                  hasAutoFocus
                  width="100%"
                />
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" label="Cancel" onClick={() => setShowNewGraphModal(false)} />
                <Button variant="primary" label="Create" isDisabled={!newGraphName.trim()} onClick={handleCreateGraph} />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Main Render (hydrated) ─────────────────────────────────────────────
  return (
    <div className="flex h-screen w-full flex-col bg-[var(--background)]">
      {/* Header */}
      <header className="relative z-30 flex h-[var(--header-height)] items-center justify-between border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-md px-5">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]" title="Back to conversations">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          </Link>
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)] text-white">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="19" cy="6" r="2" /><path d="M5 8v6a2 2 0 002 2h3M19 8v4M14 18h3a2 2 0 002-2M7 6h10" /></svg>
            </div>
            {/* Graph selector dropdown trigger */}
            <button
              onClick={() => setShowGraphSelector(!showGraphSelector)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[15px] font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
            >
              {graphName || "Graph Dashboard"}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>
          <Badge variant="neutral" label="Manual" />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant={showConversationsSidebar ? "primary" : "secondary"}
            size="sm"
            label="Sidebar"
            tooltip="Toggle workspace sidebar"
            onClick={() => setShowConversationsSidebar(!showConversationsSidebar)}
            icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>}
          />
          <Button
            variant={!panOnDrag ? "primary" : "secondary"}
            size="sm"
            label={panOnDrag ? "Lasso" : "Lasso ✓"}
            tooltip={panOnDrag ? "Lasso select" : "Pan mode"}
            onClick={() => setPanOnDrag((p) => !p)}
            icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z" /><path d="M7 5h10M7 19h10M5 7v10M19 7v10" /></svg>}
          />
          <Button
            variant="primary"
            size="sm"
            label="Add Node"
            onClick={() => setShowNodeModal(true)}
            icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>}
          />
          {(selectedFlowNodes.length > 0 || selectedNodeId) && (
            <>
              <Button
                variant="secondary"
                size="sm"
                label={copiedMessage ? "Copied!" : `Copy${selectedFlowNodes.length > 1 ? ` (${selectedFlowNodes.length})` : ""}`}
                onClick={handleCopy}
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>}
              />
              <Button
                variant="destructive"
                size="sm"
                label={`Delete${selectedFlowNodes.length > 1 ? ` (${selectedFlowNodes.length})` : ""}`}
                onClick={() => setShowDeleteConfirm(true)}
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>}
              />
            </>
          )}
          <Button
            variant="secondary"
            size="sm"
            label="Paste"
            tooltip="Paste"
            onClick={handlePaste}
            icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /></svg>}
          />
          <div className="text-[12px] text-[var(--muted-foreground)]">{persistedNodes.length} nodes · {persistedEdges.length} edges</div>
        </div>
      </header>

      {/* Graph selector dropdown */}
      {showGraphSelector && (
        <div className="fixed inset-0 z-40" onClick={() => setShowGraphSelector(false)}>
          <div className="absolute left-[140px] top-[var(--header-height)] mt-1 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="max-h-64 overflow-y-auto">
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => { switchGraph(w.id); setShowGraphSelector(false); }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] transition-colors ${w.id === activeGraphId ? "bg-[var(--accent-light)] text-[var(--accent)] font-medium" : "text-[var(--foreground)] hover:bg-[var(--muted)]"}`}
                >
                  <span className="truncate">{w.name}</span>
                  {w.id === activeGraphId && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" /></svg>
                  )}
                </button>
              ))}
            </div>
            <div className="mt-1 border-t border-[var(--border)] pt-1">
              <button
                onClick={() => { setShowNewGraphModal(true); setShowGraphSelector(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-light)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                New Graph
              </button>
            </div>
            {activeGraphId && (
              <div className="mt-1 border-t border-[var(--border)] pt-1 space-y-0.5">
                <button
                  onClick={() => { setRenameValue(graphName); setShowRenameModal(true); setShowGraphSelector(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  Rename
                </button>
                <button
                  onClick={() => { setShowDeleteGraphConfirm(true); setShowGraphSelector(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-red-600 transition-colors hover:bg-red-50 dark:hover:bg-red-950/20"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  Delete Graph
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph Dashboard sidebar — graphs (expandable) + independent conversations */}
        {showConversationsSidebar && (
          <aside className="w-[240px] border-r border-[var(--border)] bg-[var(--surface)] flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">Workspace</h3>
              <button
                onClick={handleOpenAddConversation}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                title="Add existing conversation to graph"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {/* Graph workspaces (expandable) */}
              {workspaces.map((w) => (
                <GraphSidebarItem
                  key={w.id}
                  graph={w}
                  isActive={w.id === activeGraphId}
                  conversations={w.id === activeGraphId ? conversations : []}
                  selectedConversationId={highlightedConversationId}
                  onSelectGraph={() => switchGraph(w.id)}
                  onSelectConversation={handleSelectConversationFromSidebar}
                  onRemoveConversation={(convId) => removeConversation(convId)}
                />
              ))}

              {workspaces.length === 0 && conversations.length === 0 && (
                <p className="px-2 py-3 text-[12px] text-[var(--muted-foreground)] text-center">
                  No graphs yet. Create one to get started.
                </p>
              )}
            </div>
          </aside>
        )}

        {/* Graph canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={(connection) => connection.source !== connection.target}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            panOnDrag={panOnDrag}
            selectionOnDrag={!panOnDrag}
            selectionMode={SelectionMode.Partial}
            multiSelectionKeyCode="Meta"
            fitView
            snapToGrid
            snapGrid={[16, 16]}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ style: { stroke: "#334155", strokeWidth: 2 } }}
          >
            <Controls position="bottom-left" style={{ borderRadius: "8px", border: "1px solid var(--border)" }} />
            <MiniMap position="bottom-right" style={{ borderRadius: "8px", border: "1px solid var(--border)", background: "var(--surface-raised)" }} maskColor="rgba(0,0,0,0.08)" />
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />

            {persistedNodes.length === 0 && (
              <Panel position="top-center">
                <div className="mt-32">
                  <EmptyState
                    title="Empty graph"
                    description={'Click "Add Node" to start building, or drag between nodes to create edges.'}
                    actions={<Button variant="primary" label="Create your first node" onClick={() => setShowNodeModal(true)} />}
                  />
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* Right-side detail panel */}
        {(selectedPersistedNode || selectedPersistedEdge || selectedConversation) && (
          <aside className="w-[300px] border-l border-[var(--border)] bg-[var(--surface)] flex flex-col">
            {selectedConversation && (
              <div className="flex flex-col h-full">
                <div className="shrink-0 p-4 pb-3 border-b border-[var(--border)]">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[14px] font-semibold text-[var(--foreground)]">Conversation</h2>
                    <button onClick={() => setSelectedConversationId(null)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                  <div>
                    <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Title</label>
                    <p className="mt-0.5 text-[13px] text-[var(--foreground)]">{selectedConversation.title || "Untitled"}</p>
                  </div>
                  <div className="rounded-lg bg-[var(--accent-light)] px-3 py-2">
                    <p className="text-[11px] text-[var(--accent)]">
                      This conversation is associated with this graph. Opening it will show the chat inside the dashboard.
                    </p>
                  </div>
                </div>
                <div className="shrink-0 border-t border-[var(--border)] p-3">
                  <button
                    onClick={() => setOpenChatConversationId(selectedConversation.conversation_id)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-purple-700"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                    Open the conversation
                  </button>
                </div>
              </div>
            )}
            {selectedPersistedNode && (
              <div className="flex flex-col h-full">
                <div className="shrink-0 p-4 pb-3 border-b border-[var(--border)]">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[14px] font-semibold text-[var(--foreground)]">Node</h2>
                    <button onClick={() => setSelectedNodeId(null)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                  <div><label className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Title</label><p className="mt-0.5 text-[13px] text-[var(--foreground)]">{selectedPersistedNode.data.title}</p></div>
                  {selectedPersistedNode.data.description && (<div><label className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">Description</label><p className="mt-0.5 text-[13px] text-[var(--foreground)]">{selectedPersistedNode.data.description}</p></div>)}
                  <div className="pt-2 border-t border-[var(--border)] space-y-1">
                    <button onClick={() => { setEditNodeTitle(selectedPersistedNode.data.title); setEditNodeDescription(selectedPersistedNode.data.description); setShowEditNodeModal(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      Edit
                    </button>
                    <button onClick={handleDeleteNode} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-red-600 transition-colors hover:bg-red-50 dark:hover:bg-red-950/20">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      Delete node
                    </button>
                  </div>
                </div>
                <div className="shrink-0 border-t border-[var(--border)] p-3">
                  {!selectedPersistedNode.conversationId ? (
                    <button onClick={handleStartConversation} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--accent-hover)]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                      Start a conversation
                    </button>
                  ) : (
                    <button onClick={handleContinueConversation} className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-purple-700">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                      Continue the conversation
                    </button>
                  )}
                </div>
              </div>
            )}
            {selectedPersistedEdge && (
              <div className="space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-[14px] font-semibold text-[var(--foreground)]">Edge</h2>
                  <button onClick={() => setSelectedEdgeId(null)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                <div className="pt-2 border-t border-[var(--border)] space-y-1">
                  <button onClick={() => { setEditEdgeLabel(selectedPersistedEdge.label || selectedPersistedEdge.data?.type || ""); setShowEditEdgeModal(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                  </button>
                  <button onClick={() => setShowDeleteEdgeConfirm(true)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-red-600 transition-colors hover:bg-red-50 dark:hover:bg-red-950/20">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    Delete edge
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* ─── In-dashboard chat overlay ─────────────────────────────────────── */}
      {openChatConversationId && (
        <div className="fixed inset-0 z-40 flex">
          {/* Backdrop */}
          <div
            className="flex-1 bg-black/30 backdrop-blur-[1px]"
            onClick={() => setOpenChatConversationId(null)}
          />
          {/* Chat panel slides in from the right */}
          <div className="relative flex h-full w-full max-w-[720px] flex-col border-l border-[var(--border)] bg-[var(--background)] shadow-2xl">
            {/* Panel header with close/back control */}
            <div className="flex h-[var(--header-height)] shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOpenChatConversationId(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  title="Back to graph"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                </button>
                <span className="text-[13px] font-medium text-[var(--foreground)]">Conversation</span>
                <span className="rounded bg-[var(--accent-light)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">In graph</span>
              </div>
              <button
                onClick={() => setOpenChatConversationId(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                title="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            {/* Embedded chat — reuses the full chat experience via the existing route.
                `embed=1` hides the chat page's own header/sidebar chrome. */}
            <iframe
              key={openChatConversationId}
              src={`/?id=${openChatConversationId}&embed=1`}
              className="flex-1 w-full border-0"
              title="Conversation"
            />
          </div>
        </div>
      )}

      {/* ─── Modals ────────────────────────────────────────────────────────── */}

      {/* Add Node Modal */}
      {showNodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowNodeModal(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Add Node</h2>
            <div className="mt-4 space-y-3">
              <TextInput label="Title" isRequired value={newNodeTitle} onChange={setNewNodeTitle} onEnter={handleAddNode} placeholder="e.g. Project Architecture" hasAutoFocus width="100%" />
              <TextArea label="Description" isOptional value={newNodeDescription} onChange={setNewNodeDescription} placeholder="Optional description..." rows={3} />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowNodeModal(false)} />
              <Button variant="primary" label="Add Node" isDisabled={!newNodeTitle.trim()} onClick={handleAddNode} />
            </div>
          </div>
        </div>
      )}

      {/* Add Edge Modal */}
      {showEdgeModal && pendingConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => { setShowEdgeModal(false); setPendingConnection(null); }} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Create Edge?</h2>
            <p className="mt-1 text-[13px] text-[var(--muted-foreground)]">
              <span className="font-medium text-[var(--foreground)]">{persistedNodes.find((n) => n.id === pendingConnection.source)?.data.title}</span>
              {" → "}
              <span className="font-medium text-[var(--foreground)]">{persistedNodes.find((n) => n.id === pendingConnection.target)?.data.title}</span>
            </p>
            <div className="mt-4">
              <TextInput label="Relationship Label" value={newEdgeLabel} onChange={setNewEdgeLabel} onEnter={handleAddEdge} placeholder="e.g. depends on, contains, related to..." hasAutoFocus width="100%" />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => { setShowEdgeModal(false); setPendingConnection(null); }} />
              <Button variant="primary" label="Create Edge" onClick={handleAddEdge} />
            </div>
          </div>
        </div>
      )}

      {/* Edit Node Modal */}
      {showEditNodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowEditNodeModal(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Edit Node</h2>
            <div className="mt-4 space-y-3">
              <TextInput label="Title" isRequired value={editNodeTitle} onChange={setEditNodeTitle} onEnter={handleEditNodeSave} hasAutoFocus width="100%" />
              <TextArea label="Description" isOptional value={editNodeDescription} onChange={setEditNodeDescription} rows={3} />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowEditNodeModal(false)} />
              <Button variant="primary" label="Save" isDisabled={!editNodeTitle.trim()} onClick={handleEditNodeSave} />
            </div>
          </div>
        </div>
      )}

      {/* Edit Edge Modal */}
      {showEditEdgeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowEditEdgeModal(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Edit Edge</h2>
            <div className="mt-4">
              <TextInput label="Relationship Label" value={editEdgeLabel} onChange={setEditEdgeLabel} onEnter={handleEditEdgeSave} placeholder="e.g. depends on, contains, related to..." hasAutoFocus width="100%" />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowEditEdgeModal(false)} />
              <Button variant="primary" label="Save" onClick={handleEditEdgeSave} />
            </div>
          </div>
        </div>
      )}

      {/* New Graph Modal */}
      {showNewGraphModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowNewGraphModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">New Graph</h2>
            <div className="mt-4">
              <TextInput label="Name" value={newGraphName} onChange={setNewGraphName} onEnter={handleCreateGraph} placeholder="e.g. Career Planning" hasAutoFocus width="100%" />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowNewGraphModal(false)} />
              <Button variant="primary" label="Create" isDisabled={!newGraphName.trim()} onClick={handleCreateGraph} />
            </div>
          </div>
        </div>
      )}

      {/* Rename Graph Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowRenameModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Rename Graph</h2>
            <div className="mt-4">
              <TextInput label="Name" isLabelHidden value={renameValue} onChange={setRenameValue} onEnter={handleRenameGraph} hasAutoFocus width="100%" />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowRenameModal(false)} />
              <Button variant="primary" label="Save" isDisabled={!renameValue.trim()} onClick={handleRenameGraph} />
            </div>
          </div>
        </div>
      )}

      {/* Delete Graph Confirmation */}
      {showDeleteGraphConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowDeleteGraphConfirm(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Delete &ldquo;{graphName}&rdquo;?</h2>
            <p className="mt-2 text-[13px] text-[var(--muted-foreground)]">This will permanently delete the graph and all its nodes and edges. Conversations associated with this graph will not be deleted.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowDeleteGraphConfirm(false)} />
              <Button variant="destructive" label="Delete" onClick={handleDeleteGraph} />
            </div>
          </div>
        </div>
      )}

      {/* Delete Edge Confirmation */}
      {showDeleteEdgeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowDeleteEdgeConfirm(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Delete edge?</h2>
            <p className="mt-2 text-[13px] text-[var(--muted-foreground)]">This edge will be permanently removed.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowDeleteEdgeConfirm(false)} />
              <Button variant="destructive" label="Delete" onClick={() => { handleDeleteEdge(); setShowDeleteEdgeConfirm(false); }} />
            </div>
          </div>
        </div>
      )}

      {/* Delete Node(s) Confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowDeleteConfirm(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Delete selected nodes?</h2>
            <p className="mt-2 text-[13px] text-[var(--muted-foreground)]">
              {selectedFlowNodes.length > 0 ? selectedFlowNodes.length : 1} node{(selectedFlowNodes.length > 1) ? "s" : ""} and all connected edges will be permanently deleted. Associated conversations will not be affected.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" label="Cancel" onClick={() => setShowDeleteConfirm(false)} />
              <Button variant="destructive" label="Delete" onClick={handleDeleteSelected} />
            </div>
          </div>
        </div>
      )}

      {/* Add Existing Conversation Modal */}
      {showAddConversationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowAddConversationModal(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Add Conversation</h2>
            <p className="mt-1 text-[13px] text-[var(--muted-foreground)]">Select a conversation to associate with this graph.</p>
            <div className="mt-4 max-h-64 overflow-y-auto rounded-lg border border-[var(--border)]">
              {loadingConversations && (
                <div className="flex items-center justify-center py-8">
                  <Spinner size="sm" label="Loading conversations…" />
                </div>
              )}
              {!loadingConversations && availableConversations.length === 0 && (
                <p className="py-8 text-center text-[13px] text-[var(--muted-foreground)]">No conversations available to add.</p>
              )}
              {!loadingConversations && availableConversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleAddExistingConversation(c.id)}
                  className="flex w-full items-center gap-2 border-b border-[var(--border)] px-4 py-3 text-left text-[13px] text-[var(--foreground)] transition-colors last:border-b-0 hover:bg-[var(--muted)]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" className="shrink-0"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                  <span className="truncate">{c.title || "Untitled"}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" strokeWidth="2" className="ml-auto shrink-0 opacity-0 group-hover:opacity-100"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-end">
              <Button variant="ghost" label="Close" onClick={() => setShowAddConversationModal(false)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
