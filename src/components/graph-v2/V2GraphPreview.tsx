"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import V2GraphCanvas, { type EdgeMode } from "./V2GraphCanvas";
import V2NodePanel from "./V2NodePanel";
import { normalizeGraph, type DisplayGraph } from "@/src/lib/intelligence-v2/normalize-graph";
import {
  copyNodesToClipboard,
  preparePaste,
  hasClipboardContent,
  type CopyableNode,
  type CopyableEdge,
} from "@/src/lib/graph-clipboard";

type V2GraphPreviewProps = {
  conversationId: string;
  isOpen: boolean;
  onClose: () => void;
  onContinueFromNode?: (context: V2ContinueContext) => void;
};

export type V2ContinueContext = {
  objectId: string;
  objectTitle: string;
  objectType: string;
  description: string;
  propositions: Array<{ content: string; authoredBy: string }>;
  threadSubject: string;
  supportingUtteranceIds: string[];
  contextualAssistantUtteranceIds: string[];
  parentTitle: string | null;
  relationships: Array<{ type: string; connectedTitle: string; explanation: string }>;
};

type SnapshotPayload = {
  objects: Array<{
    objectId: string;
    objectType: string;
    title: string;
    description: string;
    propositionIds: string[];
    threadIds: string[];
    supportingUtteranceIds: string[];
    contextualAssistantUtteranceIds: string[];
    maturity: string;
    status: string;
    provenanceSummary: string;
  }>;
  relationships: Array<{
    relationshipId: string;
    sourceObjectId: string;
    targetObjectId: string;
    type: string;
    family: string;
    confidence: number;
    explanation: string;
    sourcePropositionIds: string[];
  }>;
  hierarchy: Array<{
    objectId: string;
    depth: number;
    parentObjectId: string | null;
    childObjectIds: string[];
    treeId: string;
  }>;
  trees: Array<{ treeId: string; rootObjectId: string; objectIds: string[] }>;
  propositions: Array<{
    propositionId: string;
    propositionType: string;
    normalizedContent: string;
    authoredBy: string;
    provenance: string;
    sourceUtteranceIds: string[];
  }>;
  threads: Array<{ threadId: string; subject: string }>;
};

type SnapshotResponse = {
  status: "none" | "generating" | "generating_initial" | "ready" | "failed";
  snapshotStatus?: "none" | "generating_initial" | "ready" | "failed";
  updateStatus?: "idle" | "queued" | "updating" | "failed";
  graphPayload?: SnapshotPayload;
  diagnostics?: { objectCount: number; relationshipCount: number; treeCount: number; maxDepth: number };
  errorMessage?: string;
  lastUpdateError?: string | null;
  generatedAt?: string;
  generationAttemptId?: string;
  generationStartedAt?: string | null;
  loadedFromSnapshot?: boolean;
  lastProcessedMessageSeq?: number;
  latestMessageSeq?: number;
  isStale?: boolean;
};

/** Format elapsed time since a given ISO timestamp */
function formatElapsed(isoStart: string): string {
  const elapsed = Date.now() - new Date(isoStart).getTime();
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export default function V2GraphPreview({ conversationId, isOpen, onClose, onContinueFromNode }: V2GraphPreviewProps) {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("structure");
  const [panelWidth, setPanelWidth] = useState(320);
  const [isDragging, setIsDragging] = useState(false);
  /** Retains the last successful graphPayload so the graph stays visible during regeneration */
  const [lastSuccessfulPayload, setLastSuccessfulPayload] = useState<SnapshotPayload | null>(null);
  /** Error from a regeneration attempt (shown as non-blocking indicator when stale graph is displayed) */
  const [updateError, setUpdateError] = useState<string | null>(null);
  const lastSuccessfulPayloadRef = useRef<SnapshotPayload | null>(null);
  const handledOpenRef = useRef<string | null>(null);
  const [panelRefreshKey, setPanelRefreshKey] = useState(0);

  // ─── Manual editing state ───────────────────────────────────────────────
  const [showAddNodeModal, setShowAddNodeModal] = useState(false);
  const [showAddEdgeModal, setShowAddEdgeModal] = useState(false);
  const [showEditNodeModal, setShowEditNodeModal] = useState(false);
  const [editingNode, setEditingNode] = useState<{ objectId: string; title: string; description: string } | null>(null);
  const [newNodeTitle, setNewNodeTitle] = useState("");
  const [newNodeDescription, setNewNodeDescription] = useState("");
  const [newEdgeTarget, setNewEdgeTarget] = useState("");
  const [newEdgeType, setNewEdgeType] = useState("");
  const [newEdgeExplanation, setNewEdgeExplanation] = useState("");
  const [isMutating, setIsMutating] = useState(false);
  /** When non-null, user is picking a target node to connect to */
  const [connectingFromNodeId, setConnectingFromNodeId] = useState<string | null>(null);
  /** Selected edge for editing/deleting */
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showEditEdgeModal, setShowEditEdgeModal] = useState(false);
  const [editEdgeType, setEditEdgeType] = useState("");
  const [editEdgeExplanation, setEditEdgeExplanation] = useState("");

  // ─── Multi-selection state ──────────────────────────────────────────────
  const [multiSelectedNodeIds, setMultiSelectedNodeIds] = useState<string[]>([]);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const [lassoActive, setLassoActive] = useState(false);
  const [showMultiDeleteConfirm, setShowMultiDeleteConfirm] = useState(false);

  const handleSelectionChange = useCallback(({ nodes: selected }: { nodes: Array<{ id: string }> }) => {
    setMultiSelectedNodeIds(selected.map((n) => n.id));
  }, []);

  const handleCopySelectedNodes = useCallback(async () => {
    const payload = snapshot?.graphPayload ?? lastSuccessfulPayload;
    if (!payload) return;
    const ids = multiSelectedNodeIds.length > 0 ? multiSelectedNodeIds : (selectedNodeId ? [selectedNodeId] : []);
    if (ids.length === 0) return;

    const objects = payload.objects.filter((o) => ids.includes(o.objectId));

    // Use structured clipboard for cross-graph paste
    const copyableNodes: CopyableNode[] = objects.map((o) => ({
      objectId: o.objectId,
      title: o.title,
      description: o.description,
      objectType: o.objectType,
      provenanceSummary: o.provenanceSummary,
      supportingUtteranceIds: o.supportingUtteranceIds,
    }));

    const allEdges: CopyableEdge[] = (payload.relationships || []).map((r) => ({
      relationshipId: r.relationshipId,
      sourceObjectId: r.sourceObjectId,
      targetObjectId: r.targetObjectId,
      type: r.type,
      explanation: r.explanation,
    }));

    copyNodesToClipboard(copyableNodes, allEdges, conversationId, "owner");

    // Also copy text to system clipboard for external use
    const text = objects.map((o) => {
      const parts = [`Title: ${o.title}`];
      if (o.description) parts.push(`Description: ${o.description}`);
      parts.push(`Type: ${o.objectType}`);
      parts.push(`Provenance: ${o.provenanceSummary}`);
      return parts.join("\n");
    }).join("\n\n---\n\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    } catch { /* clipboard may fail */ }
  }, [multiSelectedNodeIds, selectedNodeId, snapshot, lastSuccessfulPayload, conversationId]);

  const handlePasteNodes = useCallback(async () => {
    if (!hasClipboardContent()) return;

    // Place near center of viewport (approximate)
    const pasteResult = preparePaste(400, 300, "owner");
    if (!pasteResult) return;

    // Persist via the paste API
    const res = await fetch("/api/v2/paste-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        nodes: pasteResult.nodes,
        edges: pasteResult.edges,
      }),
    });

    if (res.ok) {
      // Reload snapshot
      const snapRes = await fetch(`/api/v2/graph-snapshot?conversationId=${conversationId}`);
      const data = await snapRes.json();
      setSnapshot(data);
      if (data.graphPayload) {
        lastSuccessfulPayloadRef.current = data.graphPayload;
        setLastSuccessfulPayload(data.graphPayload);
      }
    }
  }, [conversationId]);

  const mutateGraph = useCallback(async (action: string, params: Record<string, unknown>) => {
    setIsMutating(true);
    try {
      const res = await fetch("/api/v2/manual-node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, conversationId, ...params }),
      });
      if (!res.ok) {
        const err = await res.json();
        console.error("[V2GraphPreview] mutation failed:", err);
        return false;
      }
      // Reload snapshot to reflect changes
      const snapRes = await fetch(`/api/v2/graph-snapshot?conversationId=${conversationId}`);
      const data = await snapRes.json();
      setSnapshot(data);
      if (data.graphPayload) {
        lastSuccessfulPayloadRef.current = data.graphPayload;
        setLastSuccessfulPayload(data.graphPayload);
      }
      return true;
    } catch (err) {
      console.error("[V2GraphPreview] mutation error:", err);
      return false;
    } finally {
      setIsMutating(false);
    }
  }, [conversationId]);

  const handleAddNode = useCallback(async () => {
    if (!newNodeTitle.trim()) return;
    const ok = await mutateGraph("create_node", { title: newNodeTitle.trim(), description: newNodeDescription.trim() });
    if (ok) {
      setNewNodeTitle("");
      setNewNodeDescription("");
      setShowAddNodeModal(false);
    }
  }, [newNodeTitle, newNodeDescription, mutateGraph]);

  const handleEditNodeSave = useCallback(async () => {
    if (!editingNode) return;
    const ok = await mutateGraph("edit_node", {
      objectId: editingNode.objectId,
      title: editingNode.title,
      description: editingNode.description,
    });
    if (ok) {
      setEditingNode(null);
      setShowEditNodeModal(false);
    }
  }, [editingNode, mutateGraph]);

  const handleDeleteNode = useCallback(async (objectId: string) => {
    const ok = await mutateGraph("delete_node", { objectId });
    if (ok) {
      setSelectedNodeId(null);
    }
  }, [mutateGraph]);

  const handleDeleteEdge = useCallback(async (relationshipId: string) => {
    await mutateGraph("delete_edge", { relationshipId });
    setSelectedEdgeId(null);
  }, [mutateGraph]);

  const handleDeleteSelectedNodes = useCallback(async () => {
    const ids = multiSelectedNodeIds.length > 0 ? multiSelectedNodeIds : (selectedNodeId ? [selectedNodeId] : []);
    if (ids.length === 0) return;

    // Delete each node (API removes connected edges automatically)
    for (const id of ids) {
      await mutateGraph("delete_node", { objectId: id });
    }
    setSelectedNodeId(null);
    setMultiSelectedNodeIds([]);
    setShowMultiDeleteConfirm(false);
  }, [multiSelectedNodeIds, selectedNodeId, mutateGraph]);

  const handleEdgeClick = useCallback((edgeId: string) => {
    // Always set to the clicked edge (single selection only, no toggle-off on re-click)
    setSelectedEdgeId(edgeId);
  }, []);

  const handleEditEdgeSave = useCallback(async () => {
    if (!selectedEdgeId) return;
    const ok = await mutateGraph("edit_edge", {
      relationshipId: selectedEdgeId,
      type: editEdgeType,
      explanation: editEdgeExplanation,
    });
    if (ok) {
      setShowEditEdgeModal(false);
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId, editEdgeType, editEdgeExplanation, mutateGraph]);

  const handleAddEdge = useCallback(async () => {
    if (!selectedNodeId || !newEdgeTarget) return;
    const ok = await mutateGraph("create_edge", {
      sourceObjectId: selectedNodeId,
      targetObjectId: newEdgeTarget,
      type: newEdgeType.trim() || "related_to",
      explanation: newEdgeExplanation.trim() || "User-created relationship",
    });
    if (ok) {
      setNewEdgeTarget("");
      setNewEdgeType("");
      setNewEdgeExplanation("");
      setShowAddEdgeModal(false);
    }
  }, [selectedNodeId, newEdgeTarget, newEdgeType, newEdgeExplanation, mutateGraph]);

  const handleDragConnect = useCallback((connection: { source: string; target: string }) => {
    if (connection.source === connection.target) return; // Prevent self-edges
    // Pre-fill the edge modal with source/target from the drag
    setSelectedNodeId(connection.source);
    setNewEdgeTarget(connection.target);
    setNewEdgeType("");
    setNewEdgeExplanation("");
    setShowAddEdgeModal(true);
  }, []);

  useEffect(() => {
    if (!isOpen || !conversationId) {
      handledOpenRef.current = null;
      return;
    }

    // Prevent duplicate refresh requests from rerenders or React Strict Mode.
    if (handledOpenRef.current === conversationId) return;
    handledOpenRef.current = conversationId;

    // Increment refresh key so node panel refetches messages
    setPanelRefreshKey((k) => k + 1);

    void loadSnapshot();
  }, [isOpen, conversationId]);

  async function loadSnapshot() {
    setLoading(true);
    setUpdateError(null);
    try {
      const res = await fetch(`/api/v2/graph-snapshot?conversationId=${conversationId}`);
      const data = await res.json();
      setSnapshot(data);

      // Capture the last successful payload
      if (data.graphPayload) {
        lastSuccessfulPayloadRef.current = data.graphPayload;
        setLastSuccessfulPayload(data.graphPayload);
        setUpdateError(null);
      }

      // If a generation is already in progress (from a prior Build click), poll for it
      const activeGeneration =
        data.status === "generating" ||
        data.snapshotStatus === "generating_initial" ||
        data.updateStatus === "queued" ||
        data.updateStatus === "updating";

      if (activeGeneration) {
        setGenerating(true);
        void pollUntilReady();
      } else {
        setGenerating(false);
      }

      // Do NOT auto-generate. User must explicitly click Build/Rebuild.
    } catch {
      setSnapshot({ status: "none" });
    }
    setLoading(false);
  }

  async function generateSnapshot() {
    setGenerating(true);
    setUpdateError(null);
    try {
      const res = await fetch("/api/v2/graph-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      const data = await res.json();

      if (res.status === 202 || res.ok) {
        // Generation registered — do NOT replace snapshot.graphPayload
        // Keep the existing payload visible (stale-while-refresh)
        setSnapshot((prev) => ({
          ...prev,
          status: "generating",
          generationAttemptId: data.generationAttemptId,
          generationStartedAt: data.generationStartedAt,
        } as SnapshotResponse));
        pollUntilReady();
      } else {
        // POST returned an error
        if (lastSuccessfulPayloadRef.current) {
          // Stale graph exists — show non-blocking error
          setUpdateError(data.error ?? `Request failed (${res.status})`);
        } else {
          setSnapshot({ status: "failed", errorMessage: data.error ?? `Request failed (${res.status})` });
        }
        setGenerating(false);
      }
    } catch {
      if (lastSuccessfulPayloadRef.current) {
        setUpdateError("Network error — could not reach the server.");
      } else {
        setSnapshot({ status: "failed", errorMessage: "Network error — could not reach the server." });
      }
      setGenerating(false);
    }
  }

  async function pollUntilReady() {
    const maxPolls = 120; // 10 minutes at 5s intervals
    const interval = 5000;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        const res = await fetch(`/api/v2/graph-snapshot?conversationId=${conversationId}`);
        const data = await res.json();

        if (data.status === "ready" || data.snapshotStatus === "ready") {
          setSnapshot(data);
          if (data.graphPayload) {
            lastSuccessfulPayloadRef.current = data.graphPayload;
            setLastSuccessfulPayload(data.graphPayload);
            setUpdateError(null);
          }
          setGenerating(false);
          return;
        }
        if (data.status === "failed" || data.snapshotStatus === "failed") {
          // If we have a stale graph, show it with a non-blocking error
          if (lastSuccessfulPayloadRef.current) {
            setUpdateError(data.errorMessage ?? "Update failed");
            setSnapshot((prev) => ({ ...prev, status: "failed" } as SnapshotResponse));
          } else {
            setSnapshot(data);
          }
          setGenerating(false);
          return;
        }
        // Still generating — update metadata but don't clear graphPayload
        if (!lastSuccessfulPayloadRef.current) {
          setSnapshot(data);
        }
      } catch {
        // Network blip — continue polling
      }
    }

    // Exhausted polls
    setGenerating(false);
  }

  // Normalize the raw graph into display structure
  // Prefer lastSuccessfulPayload for stale-while-refresh
  const effectivePayload = snapshot?.graphPayload ?? lastSuccessfulPayload;

  const displayGraph: DisplayGraph | null = useMemo(() => {
    if (!effectivePayload) return null;
    const gp = effectivePayload;
    return normalizeGraph(
      gp.objects as Parameters<typeof normalizeGraph>[0],
      gp.relationships as Parameters<typeof normalizeGraph>[1],
    );
  }, [effectivePayload]);

  const overlapObjectIds = useMemo(() => {
    if (!effectivePayload) return new Set<string>();
    const objects = effectivePayload.objects;
    const overlaps = new Set<string>();
    for (let i = 0; i < objects.length; i++) {
      const propsI = new Set(objects[i].propositionIds);
      for (let j = i + 1; j < objects.length; j++) {
        const shared = objects[j].propositionIds.filter((p) => propsI.has(p)).length;
        const minSize = Math.min(objects[i].propositionIds.length, objects[j].propositionIds.length);
        if (minSize > 0 && shared / minSize >= 0.5) {
          overlaps.add(objects[i].objectId);
          overlaps.add(objects[j].objectId);
        }
      }
    }
    return overlaps;
  }, [effectivePayload]);

  const handleNodeClick = useCallback((objectId: string) => {
    // If in "pick target" mode, the clicked node becomes the edge target
    if (connectingFromNodeId) {
      if (objectId !== connectingFromNodeId) {
        setNewEdgeTarget(objectId);
        setNewEdgeType("");
        setNewEdgeExplanation("");
        setShowAddEdgeModal(true);
      }
      // Clicking the source node itself cancels the mode
      setConnectingFromNodeId(null);
      return;
    }

    setSelectedNodeId((prev) => (prev === objectId ? null : objectId));
    setSelectedEdgeId(null);
    // When selecting a node, auto-switch to local semantic mode
    setEdgeMode((prev) => prev === "structure" ? "local" : prev);
  }, [connectingFromNodeId]);

  const handleClearSelection = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setEdgeMode("structure");
  }, []);

  if (!isOpen) return null;

  const gp = effectivePayload;
  const selectedObject = gp?.objects.find((o) => o.objectId === selectedNodeId) ?? null;
  const selectedHierarchy = displayGraph?.nodes.find((n) => n.objectId === selectedNodeId) ?? null;

  const structuralEdgeCount = displayGraph ? displayGraph.nodes.filter((n) => n.parentId).length + displayGraph.structuralEdges.length : 0;
  const semanticEdgeCount = displayGraph?.semanticEdges.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-800">Knowledge Map</h2>
          {displayGraph && (
            <span className="text-xs text-gray-400">
              {displayGraph.diagnostics.totalObjects} nodes · {displayGraph.diagnostics.roots} roots · depth {displayGraph.diagnostics.maxDepth}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Edge mode controls */}
          {displayGraph && (
            <div className="flex items-center rounded border border-gray-200 text-[11px]">
              <button
                onClick={() => { setEdgeMode("structure"); setSelectedNodeId(null); }}
                className={`px-2.5 py-1 ${edgeMode === "structure" ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500 hover:bg-gray-50"}`}
              >
                Structure
              </button>
              <button
                onClick={() => setEdgeMode("local")}
                className={`px-2.5 py-1 border-l border-gray-200 ${edgeMode === "local" ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500 hover:bg-gray-50"}`}
              >
                Local
              </button>
              <button
                onClick={() => setEdgeMode("all")}
                className={`px-2.5 py-1 border-l border-gray-200 ${edgeMode === "all" ? "bg-yellow-50 font-medium text-yellow-700" : "text-gray-500 hover:bg-gray-50"}`}
              >
                All edges
              </button>
            </div>
          )}
          <span className="text-[10px] text-gray-400">
            {structuralEdgeCount} structural · {semanticEdgeCount} semantic
          </span>
          {/* Updates available indicator */}
          {snapshot && !generating && (snapshot.isStale || (snapshot.latestMessageSeq ?? 0) > (snapshot.lastProcessedMessageSeq ?? 0)) && effectivePayload && (
            <span className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-0.5">Updates available</span>
          )}
          {/* Build / Rebuild button */}
          <button
            onClick={generateSnapshot}
            disabled={generating}
            className="rounded-lg bg-purple-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generating ? "Building…" : (effectivePayload ? "Rebuild Graph" : "Build Graph")}
          </button>
          <button onClick={onClose} className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100">
            Close
          </button>
        </div>
      </div>

      {/* Manual editing toolbar — only shown when graph exists */}
      {effectivePayload && (
        <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-1.5 bg-gray-50/50">
          <span className="text-[11px] text-gray-400 mr-1">Manual:</span>
          <button
            onClick={() => setLassoActive((prev) => !prev)}
            className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              lassoActive
                ? "bg-indigo-100 text-indigo-700 border border-indigo-300"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            title={lassoActive ? "Switch to pan mode" : "Switch to lasso select mode"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z" />
              <path d="M7 5h10M7 19h10M5 7v10M19 7v10" />
            </svg>
            {lassoActive ? "Lasso ✓" : "Lasso"}
          </button>
          <button
            onClick={() => { setNewNodeTitle(""); setNewNodeDescription(""); setShowAddNodeModal(true); }}
            className="flex items-center gap-1 rounded-md bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            Add Node
          </button>
          {selectedNodeId && (
            <>
              <button
                onClick={() => {
                  const obj = effectivePayload?.objects.find((o) => o.objectId === selectedNodeId);
                  if (obj) {
                    setEditingNode({ objectId: obj.objectId, title: obj.title, description: obj.description });
                    setShowEditNodeModal(true);
                  }
                }}
                className="flex items-center gap-1 rounded-md bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-200 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Edit
              </button>
              <button
                onClick={() => handleDeleteNode(selectedNodeId)}
                disabled={isMutating}
                className="flex items-center gap-1 rounded-md bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-100 transition-colors disabled:opacity-50"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                Delete
              </button>
              <button
                onClick={() => { setConnectingFromNodeId(selectedNodeId); }}
                className="flex items-center gap-1 rounded-md bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-200 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                Connect
              </button>
            </>
          )}
          {isMutating && (
            <div className="ml-2 h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" />
          )}
          {(multiSelectedNodeIds.length > 0 || selectedNodeId) && (
            <>
              <button
                onClick={handleCopySelectedNodes}
                className="flex items-center gap-1 rounded-md bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-200 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
                {copiedMessage ? "Copied!" : `Copy${multiSelectedNodeIds.length > 1 ? ` (${multiSelectedNodeIds.length})` : ""}`}
              </button>
              <button
                onClick={() => setShowMultiDeleteConfirm(true)}
                className="flex items-center gap-1 rounded-md bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-100 transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                Delete{multiSelectedNodeIds.length > 1 ? ` (${multiSelectedNodeIds.length})` : ""}
              </button>
            </>
          )}
          <button
            onClick={handlePasteNodes}
            className="flex items-center gap-1 rounded-md bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-200 transition-colors"
            title="Paste copied nodes into this graph"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            Paste
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          {loading && <div className="flex h-full items-center justify-center text-gray-400">Loading snapshot…</div>}

          {!loading && (snapshot?.snapshotStatus === "none" || snapshot?.status === "none") && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="text-4xl opacity-30">🧪</div>
              <p className="text-sm text-gray-600">No graph has been built yet.</p>
              <button onClick={generateSnapshot} disabled={generating} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {generating ? "Building…" : "Build Graph"}
              </button>
              <p className="max-w-xs text-xs text-gray-400">Analyzes your conversation and constructs a knowledge graph. This may take a few minutes.</p>
            </div>
          )}

          {!loading && (snapshot?.snapshotStatus === "generating_initial" || snapshot?.status === "generating") && !effectivePayload && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-300 border-t-purple-600" />
              <p className="text-sm text-gray-600">Generating V2 graph…</p>
              <p className="text-xs text-gray-400 max-w-xs">
                {snapshot?.generationStartedAt
                  ? `Started ${formatElapsed(snapshot.generationStartedAt as string)}. Large conversations may take several minutes.`
                  : "This may take a few minutes for large conversations."}
              </p>
              {!generating && (
                <button
                  onClick={generateSnapshot}
                  className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                >
                  Start fresh attempt
                </button>
              )}
            </div>
          )}

          {!loading && (snapshot?.snapshotStatus === "failed" || snapshot?.status === "failed") && !effectivePayload && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="text-3xl opacity-40">⚠️</div>
              <p className="text-sm text-red-600 max-w-sm">{snapshot.errorMessage ?? "Generation failed"}</p>
              <button onClick={generateSnapshot} disabled={generating} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {generating ? "Generating…" : "Retry"}
              </button>
            </div>
          )}

          {!loading && gp && (
            <div className="relative h-full">
              {displayGraph && (
                <V2GraphCanvas
                  displayGraph={displayGraph}
                  overlapObjectIds={overlapObjectIds}
                  selectedNodeId={selectedNodeId}
                  selectedEdgeId={selectedEdgeId}
                  edgeMode={edgeMode}
                  onNodeClick={handleNodeClick}
                  onEdgeClick={handleEdgeClick}
                  onConnect={(conn) => { if (conn.source && conn.target) handleDragConnect({ source: conn.source, target: conn.target }); }}
                  onSelectionChange={handleSelectionChange}
                  panOnDrag={!lassoActive}
                />
              )}

              {/* Non-blocking "Updating graph" indicator (stale-while-refresh) */}

              {/* "Pick target" mode indicator */}
              {connectingFromNodeId && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 rounded-xl bg-indigo-600 px-4 py-2.5 shadow-lg text-white">
                  <div className="h-2.5 w-2.5 rounded-full bg-white animate-pulse" />
                  <span className="text-xs font-medium">
                    Click a node to connect from &quot;{effectivePayload?.objects.find((o) => o.objectId === connectingFromNodeId)?.title}&quot;
                  </span>
                  <button
                    onClick={() => setConnectingFromNodeId(null)}
                    className="ml-1 rounded-md bg-white/20 px-2 py-0.5 text-[11px] font-medium hover:bg-white/30 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {generating && (
                <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg bg-white/90 border border-purple-200 px-3 py-1.5 shadow-sm z-10">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-purple-300 border-t-purple-600" />
                  <span className="text-xs text-gray-600">Updating graph…</span>
                  {snapshot?.generationStartedAt && (
                    <span className="text-[10px] text-gray-400">{formatElapsed(snapshot.generationStartedAt as string)}</span>
                  )}
                </div>
              )}

              {/* Non-blocking update error with retry */}
              {!generating && updateError && (
                <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 shadow-sm z-10">
                  <span className="text-xs text-red-600 max-w-[200px] truncate">{updateError}</span>
                  <button onClick={generateSnapshot} className="text-xs text-red-500 underline whitespace-nowrap">Retry</button>
                </div>
              )}

              {/* Incremental update indicator */}
              {!generating && !updateError && (snapshot?.updateStatus === "queued" || snapshot?.updateStatus === "updating") && (
                <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg bg-white/90 border border-gray-200 px-3 py-1.5 shadow-sm z-10">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-purple-300 border-t-purple-600" />
                  <span className="text-xs text-gray-600">Updating graph…</span>
                </div>
              )}
              {!generating && !updateError && snapshot?.updateStatus === "failed" && (
                <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 z-10">
                  <span className="text-xs text-red-600">Update failed</span>
                  <button onClick={loadSnapshot} className="text-xs text-red-500 underline">Retry</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right-side details panel (node or edge) with drag resize */}
        {((selectedObject && gp) || (selectedEdgeId && gp)) && (
          <>
            {/* Resize handle */}
            <div
              className="w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-purple-300 active:bg-purple-400 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDragging(true);
                const startX = e.clientX;
                const startWidth = panelWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  const newWidth = Math.max(240, Math.min(600, startWidth + delta));
                  setPanelWidth(newWidth);
                };
                const onUp = () => {
                  setIsDragging(false);
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />
            <div className="shrink-0 border-l border-gray-200 overflow-hidden" style={{ width: panelWidth }}>
              {/* Node details */}
              {selectedObject && !selectedEdgeId && (
                <V2NodePanel
                  object={selectedObject}
                  propositions={gp.propositions}
                  relationships={gp.relationships}
                  hierarchyNode={selectedHierarchy ? { objectId: selectedHierarchy.objectId, depth: selectedHierarchy.depth, parentObjectId: selectedHierarchy.parentId, childObjectIds: selectedHierarchy.childIds } : null}
                  allObjects={gp.objects}
                  hasOverlap={overlapObjectIds.has(selectedObject.objectId)}
                  conversationId={conversationId}
                  refreshKey={panelRefreshKey}
                  onClose={handleClearSelection}
                  onSelectNode={(objectId) => setSelectedNodeId(objectId)}
                  onExpandChange={(expanded) => setPanelWidth(expanded ? Math.max(window.innerWidth * 0.45, 500) : 320)}
                  onStartConversation={onContinueFromNode ? (objectId) => {
                    // For manual nodes without conversation, start one using the same continue flow
                    // The node's title and description serve as the conversation context
                    const obj = gp.objects.find((o) => o.objectId === objectId);
                    if (!obj) return;
                    onContinueFromNode({
                      objectId: obj.objectId,
                      objectTitle: obj.title,
                      objectType: obj.objectType,
                      description: obj.description,
                      propositions: [],
                      threadSubject: obj.title,
                      supportingUtteranceIds: [],
                      contextualAssistantUtteranceIds: [],
                      parentTitle: null,
                      relationships: [],
                    });
                  } : undefined}
                  onContinue={onContinueFromNode ? (objectId) => {
                    const obj = gp.objects.find((o) => o.objectId === objectId);
                    if (!obj) return;
                    const objProps = gp.propositions.filter((p) => obj.propositionIds.includes(p.propositionId));
                    const thread = gp.threads?.find((t) => obj.threadIds.includes(t.threadId));
                    const hierNode = displayGraph?.nodes.find((n) => n.objectId === objectId);
                    const parentObj = hierNode?.parentId ? gp.objects.find((o) => o.objectId === hierNode.parentId) : null;
                    const connectedRels = gp.relationships.filter(
                      (r) => r.sourceObjectId === objectId || r.targetObjectId === objectId,
                    ).slice(0, 5);
                    onContinueFromNode({
                      objectId: obj.objectId,
                      objectTitle: obj.title,
                      objectType: obj.objectType,
                      description: obj.description,
                      propositions: objProps.map((p) => ({ content: p.normalizedContent, authoredBy: p.authoredBy })),
                      threadSubject: thread?.subject ?? "",
                      supportingUtteranceIds: obj.supportingUtteranceIds ?? [],
                      contextualAssistantUtteranceIds: obj.contextualAssistantUtteranceIds ?? [],
                      parentTitle: parentObj?.title ?? null,
                      relationships: connectedRels.map((r) => {
                        const otherId = r.sourceObjectId === objectId ? r.targetObjectId : r.sourceObjectId;
                        const other = gp.objects.find((o) => o.objectId === otherId);
                        return { type: r.type, connectedTitle: other?.title ?? "", explanation: r.explanation };
                      }),
                    });
                  } : undefined}
                />
              )}

              {/* Edge actions (minimal: Edit + Delete) */}
              {selectedEdgeId && (() => {
                const rel = gp.relationships.find((r) => r.relationshipId === selectedEdgeId);
                if (!rel) return null;
                return (
                  <div className="h-full flex flex-col p-4">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-2">
                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-100">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-indigo-600" strokeLinecap="round">
                            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </div>
                        <h3 className="text-sm font-semibold text-gray-800">Edge</h3>
                      </div>
                      <button onClick={handleClearSelection} className="rounded p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                      </button>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => {
                          setEditEdgeType(rel.type);
                          setEditEdgeExplanation(rel.explanation);
                          setShowEditEdgeModal(true);
                        }}
                        className="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteEdge(selectedEdgeId)}
                        disabled={isMutating}
                        className="flex items-center gap-2 rounded-lg bg-red-50 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-100 transition-colors disabled:opacity-50"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>

      {/* ─── Add Node Modal ─────────────────────────────────────────────── */}
      {showAddNodeModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowAddNodeModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800">Add Node</h3>
            <p className="mt-1 text-xs text-gray-500">Create a manual node in your Knowledge Map.</p>
            <div className="mt-3 space-y-2">
              <input
                type="text" value={newNodeTitle} onChange={(e) => setNewNodeTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddNode()}
                placeholder="Node title" autoFocus
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <textarea
                value={newNodeDescription} onChange={(e) => setNewNodeDescription(e.target.value)}
                placeholder="Description (optional)" rows={2}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-none focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowAddNodeModal(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={handleAddNode} disabled={!newNodeTitle.trim() || isMutating}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {isMutating ? "Creating…" : "Add Node"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Node Modal ────────────────────────────────────────────── */}
      {showEditNodeModal && editingNode && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowEditNodeModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800">Edit Node</h3>
            <div className="mt-3 space-y-2">
              <input
                type="text" value={editingNode.title}
                onChange={(e) => setEditingNode({ ...editingNode, title: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && handleEditNodeSave()}
                placeholder="Node title" autoFocus
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <textarea
                value={editingNode.description}
                onChange={(e) => setEditingNode({ ...editingNode, description: e.target.value })}
                placeholder="Description" rows={3}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-none focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowEditNodeModal(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={handleEditNodeSave} disabled={!editingNode.title.trim() || isMutating}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {isMutating ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Create Edge Confirmation Modal ─────────────────────────────── */}
      {showAddEdgeModal && selectedNodeId && newEdgeTarget && effectivePayload && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowAddEdgeModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800">Create Edge?</h3>
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2.5">
              <span className="text-xs font-medium text-gray-800 truncate max-w-[140px]">
                {effectivePayload.objects.find((o) => o.objectId === selectedNodeId)?.title}
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-indigo-500 shrink-0">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              <span className="text-xs font-medium text-gray-800 truncate max-w-[140px]">
                {effectivePayload.objects.find((o) => o.objectId === newEdgeTarget)?.title}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              <div>
                <label className="text-[11px] font-medium text-gray-600">Relationship type</label>
                <input
                  type="text" value={newEdgeType} onChange={(e) => setNewEdgeType(e.target.value)}
                  placeholder="e.g. depends_on, related_to, contains"
                  autoFocus
                  className="mt-0.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-gray-600">Explanation (optional)</label>
                <input
                  type="text" value={newEdgeExplanation} onChange={(e) => setNewEdgeExplanation(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddEdge()}
                  placeholder="Why are these connected?"
                  className="mt-0.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowAddEdgeModal(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={handleAddEdge} disabled={isMutating}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {isMutating ? "Connecting…" : "Create Edge"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Edge Modal ────────────────────────────────────────────── */}
      {showEditEdgeModal && selectedEdgeId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowEditEdgeModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800">Edit Edge</h3>
            <div className="mt-3 space-y-2">
              <div>
                <label className="text-[11px] font-medium text-gray-600">Relationship type</label>
                <input
                  type="text" value={editEdgeType} onChange={(e) => setEditEdgeType(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleEditEdgeSave()}
                  placeholder="e.g. depends_on, related_to, contains"
                  autoFocus
                  className="mt-0.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-gray-600">Explanation</label>
                <input
                  type="text" value={editEdgeExplanation} onChange={(e) => setEditEdgeExplanation(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleEditEdgeSave()}
                  placeholder="Why are these connected?"
                  className="mt-0.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowEditEdgeModal(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={handleEditEdgeSave} disabled={isMutating}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {isMutating ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Multi-Delete Confirmation Modal ────────────────────────────── */}
      {showMultiDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowMultiDeleteConfirm(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-200 bg-white p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800">Delete selected nodes?</h3>
            <p className="mt-2 text-xs text-gray-500">
              {multiSelectedNodeIds.length > 0 ? multiSelectedNodeIds.length : 1} node{(multiSelectedNodeIds.length > 1) ? "s" : ""} and all connected edges will be permanently deleted.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowMultiDeleteConfirm(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={handleDeleteSelectedNodes} disabled={isMutating}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {isMutating ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
