"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import V2GraphCanvas, { type EdgeMode } from "./V2GraphCanvas";
import V2NodePanel from "./V2NodePanel";
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
  status: "none" | "generating" | "ready" | "failed";
  graphPayload?: SnapshotPayload;
  diagnostics?: { objectCount: number; relationshipCount: number; treeCount: number; maxDepth: number };
  errorMessage?: string;
  generatedAt?: string;
  loadedFromSnapshot?: boolean;
};

export default function V2GraphPreview({ conversationId, isOpen, onClose, onContinueFromNode }: V2GraphPreviewProps) {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("structure");

  useEffect(() => {
    if (!isOpen || !conversationId) return;
    loadSnapshot();
  }, [isOpen, conversationId]);

  async function loadSnapshot() {
    setLoading(true);
    try {
      const res = await fetch(`/api/v2/graph-snapshot?conversationId=${conversationId}`);
      const data = await res.json();
      setSnapshot(data);
    } catch {
      setSnapshot({ status: "none" });
    }
    setLoading(false);
  }

  async function generateSnapshot() {
    setGenerating(true);
    setSnapshot({ status: "generating" });
    try {
      const res = await fetch("/api/v2/graph-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      if (res.ok) { await loadSnapshot(); }
      else { const err = await res.json(); setSnapshot({ status: "failed", errorMessage: err.error }); }
    } catch { setSnapshot({ status: "failed", errorMessage: "Network error" }); }
    setGenerating(false);
  }

  // Normalize the raw graph into display structure
  const displayGraph: DisplayGraph | null = useMemo(() => {
    if (!snapshot?.graphPayload) return null;
    const gp = snapshot.graphPayload;
    return normalizeGraph(
      gp.objects as Parameters<typeof normalizeGraph>[0],
      gp.relationships as Parameters<typeof normalizeGraph>[1],
    );
  }, [snapshot?.graphPayload]);

  const overlapObjectIds = useMemo(() => {
    if (!snapshot?.graphPayload) return new Set<string>();
    const objects = snapshot.graphPayload.objects;
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
  }, [snapshot?.graphPayload]);

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

  const gp = snapshot?.graphPayload;
  const selectedObject = gp?.objects.find((o) => o.objectId === selectedNodeId) ?? null;
  const selectedHierarchy = displayGraph?.nodes.find((n) => n.objectId === selectedNodeId) ?? null;

  const structuralEdgeCount = displayGraph ? displayGraph.nodes.filter((n) => n.parentId).length + displayGraph.structuralEdges.length : 0;
  const semanticEdgeCount = displayGraph?.semanticEdges.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-800">V2 Graph Preview</h2>
          <span className="rounded bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700">ALPHA</span>
          {displayGraph && (
            <span className="text-xs text-gray-400">
              {displayGraph.diagnostics.totalObjects} nodes · {displayGraph.diagnostics.roots} roots · {displayGraph.diagnostics.trees} trees · depth {displayGraph.diagnostics.maxDepth}
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
          <button onClick={onClose} className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100">
            Close
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          {loading && <div className="flex h-full items-center justify-center text-gray-400">Loading snapshot…</div>}

          {!loading && snapshot?.status === "none" && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="text-4xl opacity-30">🧪</div>
              <p className="text-sm text-gray-600">No V2 graph snapshot exists.</p>
              <button onClick={generateSnapshot} disabled={generating} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {generating ? "Generating…" : "Generate V2 Graph Preview"}
              </button>
              <p className="max-w-xs text-xs text-gray-400">The alpha pipeline may take several minutes.</p>
            </div>
          )}

          {!loading && snapshot?.status === "generating" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-300 border-t-purple-600" />
              <p className="text-sm text-gray-600">Generating V2 graph…</p>
            </div>
          )}

          {!loading && snapshot?.status === "failed" && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <p className="text-sm text-red-600">{snapshot.errorMessage ?? "Generation failed"}</p>
              <button onClick={generateSnapshot} disabled={generating} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200">Retry</button>
            </div>
          )}

          {!loading && snapshot?.status === "ready" && displayGraph && (
            <V2GraphCanvas
              displayGraph={displayGraph}
              overlapObjectIds={overlapObjectIds}
              selectedNodeId={selectedNodeId}
              edgeMode={edgeMode}
              onNodeClick={handleNodeClick}
            />
          )}
        </div>

        {/* Node panel */}
        {selectedObject && gp && (
          <div className="w-80 shrink-0 border-l border-gray-200 overflow-hidden">
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
                onContinueFromNode({
                  objectId: obj.objectId,
                  objectTitle: obj.title,
                  objectType: obj.objectType,
                  description: obj.description,
                  propositions: objProps.map((p) => ({ content: p.normalizedContent, authoredBy: p.authoredBy })),
                  threadSubject: thread?.subject ?? "",
                });
              } : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
