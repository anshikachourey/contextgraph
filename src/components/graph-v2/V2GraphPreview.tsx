"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import V2GraphCanvas, { type EdgeMode } from "./V2GraphCanvas";
import V2NodePanel from "./V2NodePanel";
import ConceptualMapView from "./conceptual-map/ConceptualMapView";
import { SYNTHETIC_ROOT_ID } from "./conceptual-map/derive-map";
import { normalizeGraph, type DisplayGraph } from "@/src/lib/intelligence-v2/normalize-graph";

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
  const [viewMode, setViewMode] = useState<"conceptual" | "network">("conceptual");
  /** Retains the last successful graphPayload so the graph stays visible during regeneration */
  const [lastSuccessfulPayload, setLastSuccessfulPayload] = useState<SnapshotPayload | null>(null);
  /** Error from a regeneration attempt (shown as non-blocking indicator when stale graph is displayed) */
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !conversationId) return;
    loadSnapshot();
  }, [isOpen, conversationId]);

  async function loadSnapshot() {
    setLoading(true);
    setUpdateError(null);
    try {
      const res = await fetch(`/api/v2/graph-snapshot?conversationId=${conversationId}`);
      const data = await res.json();
      setSnapshot(data);

      // Capture successful payload
      if (data.graphPayload) {
        setLastSuccessfulPayload(data.graphPayload);
        setUpdateError(null);
      }

      // If the server reports active generation, start polling
      if ((data.status === "generating" || data.snapshotStatus === "generating_initial") && !data.graphPayload) {
        setGenerating(true);
        pollUntilReady();
      }
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
        if (lastSuccessfulPayload) {
          // Stale graph exists — show non-blocking error
          setUpdateError(data.error ?? `Request failed (${res.status})`);
        } else {
          setSnapshot({ status: "failed", errorMessage: data.error ?? `Request failed (${res.status})` });
        }
        setGenerating(false);
      }
    } catch {
      if (lastSuccessfulPayload) {
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
            setLastSuccessfulPayload(data.graphPayload);
            setUpdateError(null);
          }
          setGenerating(false);
          return;
        }
        if (data.status === "failed" || data.snapshotStatus === "failed") {
          // If we have a stale graph, show it with a non-blocking error
          if (lastSuccessfulPayload) {
            setUpdateError(data.errorMessage ?? "Update failed");
            setSnapshot((prev) => ({ ...prev, status: "failed" } as SnapshotResponse));
          } else {
            setSnapshot(data);
          }
          setGenerating(false);
          return;
        }
        // Still generating — update metadata but don't clear graphPayload
        if (!lastSuccessfulPayload) {
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
    setSelectedNodeId((prev) => (prev === objectId ? null : objectId));
    // When selecting a node, auto-switch to local semantic mode
    setEdgeMode((prev) => prev === "structure" ? "local" : prev);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedNodeId(null);
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
          {/* View mode toggle */}
          {gp && (
            <div className="flex items-center rounded-lg border border-gray-200 text-[11px]">
              <button
                onClick={() => setViewMode("conceptual")}
                className={`px-3 py-1 rounded-l-lg transition ${viewMode === "conceptual" ? "bg-indigo-50 font-medium text-indigo-700" : "text-gray-500 hover:bg-gray-50"}`}
              >
                Conceptual
              </button>
              <button
                onClick={() => setViewMode("network")}
                className={`px-3 py-1 rounded-r-lg border-l border-gray-200 transition ${viewMode === "network" ? "bg-gray-100 font-medium text-gray-800" : "text-gray-500 hover:bg-gray-50"}`}
              >
                Full network
              </button>
            </div>
          )}
          {displayGraph && viewMode === "network" && (
            <span className="text-xs text-gray-400">
              {displayGraph.diagnostics.totalObjects} nodes · {displayGraph.diagnostics.roots} roots · depth {displayGraph.diagnostics.maxDepth}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Edge mode controls — only in network mode */}
          {displayGraph && viewMode === "network" && (
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
          {viewMode === "network" && (
            <span className="text-[10px] text-gray-400">
              {structuralEdgeCount} structural · {semanticEdgeCount} semantic
            </span>
          )}
          <button onClick={onClose} className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100">
            Close
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          {loading && <div className="flex h-full items-center justify-center text-gray-400">Loading snapshot…</div>}

          {!loading && (snapshot?.snapshotStatus === "none" || snapshot?.status === "none") && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="text-4xl opacity-30">🧪</div>
              <p className="text-sm text-gray-600">No V2 graph snapshot exists.</p>
              <button onClick={generateSnapshot} disabled={generating} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {generating ? "Generating…" : "Generate V2 Graph Preview"}
              </button>
              <p className="max-w-xs text-xs text-gray-400">The alpha pipeline may take several minutes.</p>
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
              {viewMode === "conceptual" ? (
                <ConceptualMapView
                  graphPayload={gp}
                  selectedNodeId={selectedNodeId === SYNTHETIC_ROOT_ID ? null : selectedNodeId}
                  onNodeClick={handleNodeClick}
                  onClearSelection={handleClearSelection}
                />
              ) : displayGraph ? (
                <V2GraphCanvas
                  displayGraph={displayGraph}
                  overlapObjectIds={overlapObjectIds}
                  selectedNodeId={selectedNodeId}
                  edgeMode={edgeMode}
                  onNodeClick={handleNodeClick}
                />
              ) : null}

              {/* Non-blocking "Updating graph" indicator (stale-while-refresh) */}
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

        {/* Node panel with drag resize */}
        {selectedObject && gp && (
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
              <V2NodePanel
              object={selectedObject}
              propositions={gp.propositions}
              relationships={gp.relationships}
              hierarchyNode={selectedHierarchy ? { objectId: selectedHierarchy.objectId, depth: selectedHierarchy.depth, parentObjectId: selectedHierarchy.parentId, childObjectIds: selectedHierarchy.childIds } : null}
              allObjects={gp.objects}
              hasOverlap={overlapObjectIds.has(selectedObject.objectId)}
              conversationId={conversationId}
              onClose={handleClearSelection}
              onSelectNode={(objectId) => setSelectedNodeId(objectId)}
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
