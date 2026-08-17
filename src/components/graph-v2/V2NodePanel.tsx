"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

type Proposition = {
  propositionId: string;
  normalizedContent: string;
  authoredBy: string;
  provenance: string;
  sourceUtteranceIds: string[];
};

type Relationship = {
  relationshipId: string;
  sourceObjectId: string;
  targetObjectId: string;
  type: string;
  explanation: string;
  confidence: number;
};

type HierarchyNode = {
  objectId: string;
  depth: number;
  parentObjectId: string | null;
  childObjectIds: string[];
};

type V2Object = {
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
};

type SourceMessage = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

type V2NodePanelProps = {
  object: V2Object;
  propositions: Proposition[];
  relationships: Relationship[];
  hierarchyNode: HierarchyNode | null;
  allObjects: V2Object[];
  hasOverlap: boolean;
  conversationId: string;
  refreshKey?: number;
  onClose: () => void;
  onContinue?: (objectId: string) => void;
  onStartConversation?: (objectId: string) => void;
  onSelectNode?: (objectId: string) => void;
  onExpandChange?: (expanded: boolean) => void;
};

// ─── Relationship label helpers ─────────────────────────────────────────────

const RELATIONSHIP_LABELS: Record<string, string> = {
  child_of: "subtopic of",
  elaborates: "elaborates on",
  supports: "supports",
  evidence_for: "provides evidence for",
  answers: "answers",
  raises_question: "raises a question about",
  contrasts_with: "contrasts with",
  leads_to: "leads to",
  depends_on: "depends on",
  specializes: "specializes",
  generalizes: "generalizes",
  example_of: "is an example of",
  reframes: "reframes",
  causes: "causes",
  tangent_from: "tangent from",
  diverged_from: "diverged from",
  continued_from: "continued from",
};

function friendlyLabel(type: string, isSource: boolean): string {
  const base = RELATIONSHIP_LABELS[type] ?? type.replace(/_/g, " ");
  return isSource ? base : `is ${base.replace(/^(is |)/, "")} by`;
}

// ─── Component ──────────────────────────────────────────────────────────────

type Tab = "overview" | "conversation";

export default function V2NodePanel({
  object,
  propositions,
  relationships,
  hierarchyNode,
  allObjects,
  hasOverlap,
  conversationId,
  refreshKey,
  onClose,
  onContinue,
  onStartConversation,
  onSelectNode,
  onExpandChange,
}: V2NodePanelProps) {
  const [messages, setMessages] = useState<SourceMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showAllRelationships, setShowAllRelationships] = useState(false);
  const [expandedExplanation, setExpandedExplanation] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [conversationExpanded, setConversationExpanded] = useState(false);

  const [refetchKey, setRefetchKey] = useState(0);

  // Determine if conversation data exists (check utterance IDs or completed exchange)
  const hasUtteranceSource =
    (object.supportingUtteranceIds?.length ?? 0) > 0 ||
    (object.contextualAssistantUtteranceIds?.length ?? 0) > 0;
  // A completed exchange requires at least one user message AND one assistant message with content
  const hasCompletedExchange =
    messages.some((m) => m.role === "user") &&
    messages.some((m) => m.role === "assistant" && m.content.length > 0);
  const hasConversationSource = hasUtteranceSource || hasCompletedExchange;

  // Fetch source messages
  useEffect(() => {
    const allMessageIds = [
      ...(object.supportingUtteranceIds || []),
      ...(object.contextualAssistantUtteranceIds || []),
    ];
    const uniqueIds = [...new Set(allMessageIds)];

    setLoadingMessages(true);

    const params = new URLSearchParams({ conversationId });
    if (uniqueIds.length > 0) params.set("messageIds", uniqueIds.join(","));
    params.set("parentNodeId", object.objectId);
    params.set("continuationEntityId", object.objectId);

    fetch(`/api/messages?${params.toString()}`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        const msgs = (Array.isArray(data) ? data : []) as SourceMessage[];
        msgs.sort((a, b) => a.created_at.localeCompare(b.created_at));
        setMessages(msgs);
      })
      .catch(() => setMessages([]))
      .finally(() => setLoadingMessages(false));
  }, [object.objectId, object.supportingUtteranceIds, object.contextualAssistantUtteranceIds, conversationId, refetchKey, refreshKey]);

  const refetchMessages = useCallback(() => setRefetchKey((k) => k + 1), []);

  // Reset tab when object changes
  useEffect(() => {
    setActiveTab("overview");
    setConversationExpanded(false);
  }, [object.objectId]);

  // Derive relationship groups
  const connectedRels = relationships.filter(
    (r) => r.sourceObjectId === object.objectId || r.targetObjectId === object.objectId,
  );

  const parent = hierarchyNode?.parentObjectId
    ? allObjects.find((o) => o.objectId === hierarchyNode.parentObjectId)
    : null;

  const children = (hierarchyNode?.childObjectIds ?? [])
    .map((id) => allObjects.find((o) => o.objectId === id))
    .filter(Boolean) as V2Object[];

  const semanticRels = connectedRels.filter(
    (r) => r.type !== "child_of" && r.type !== "tangent_from" && r.type !== "diverged_from" && r.type !== "continued_from",
  );

  const visibleRels = showAllRelationships ? semanticRels : semanticRels.slice(0, 4);

  return (
    <div className="flex h-full flex-col">
      {/* ─── Permanent header: type + title + close ──────────────────────── */}
      <div className="shrink-0 border-b border-gray-100 px-4 pt-4 pb-0">
        <div className="flex items-start justify-between mb-2">
          <div>
            <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 capitalize">
              {object.objectType.replace(/_/g, " ")}
            </span>
            <h3 className="mt-1.5 text-[15px] font-semibold leading-snug">{object.title}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none ml-2">×</button>
        </div>

        {/* ─── Tabs ────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-0 -mb-px">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition ${
              activeTab === "overview"
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Overview
          </button>
          {hasConversationSource && (
            <button
              onClick={() => setActiveTab("conversation")}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition ${
                activeTab === "conversation"
                  ? "border-purple-600 text-purple-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Conversation
            </button>
          )}
        </div>
      </div>

      {/* ─── Tab body ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col">

        {/* Overview tab */}
        {activeTab === "overview" && (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Description */}
            <p className="text-sm text-gray-600 leading-relaxed">{object.description}</p>

            {/* Relationships */}
            {(parent || children.length > 0 || semanticRels.length > 0) && (
              <div className="space-y-3">
                {parent && (
                  <div>
                    <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">Part of</p>
                    <button
                      onClick={() => onSelectNode?.(parent.objectId)}
                      className="w-full text-left rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 transition"
                    >
                      <span className="font-medium">{parent.title}</span>
                    </button>
                  </div>
                )}

                {children.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">Subtopics</p>
                    {children.map((c) => (
                      <button
                        key={c.objectId}
                        onClick={() => onSelectNode?.(c.objectId)}
                        className="w-full text-left rounded-lg bg-gray-50 px-3 py-1.5 mb-1 text-xs text-gray-700 hover:bg-gray-100 transition"
                      >
                        {c.title}
                      </button>
                    ))}
                  </div>
                )}

                {semanticRels.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">Related ideas</p>
                    <div className="space-y-1">
                      {visibleRels.map((r) => {
                        const isSource = r.sourceObjectId === object.objectId;
                        const otherId = isSource ? r.targetObjectId : r.sourceObjectId;
                        const otherObj = allObjects.find((o) => o.objectId === otherId);
                        if (!otherObj) return null;
                        return (
                          <div key={r.relationshipId} className="rounded-lg bg-gray-50 px-3 py-2">
                            <button onClick={() => onSelectNode?.(otherId)} className="w-full text-left text-xs">
                              <span className="text-gray-500">{friendlyLabel(r.type, isSource)}</span>
                              <span className="ml-1 font-medium text-gray-700">{otherObj.title}</span>
                            </button>
                            {expandedExplanation === r.relationshipId ? (
                              <p className="mt-1 text-[11px] text-gray-400 italic">{r.explanation}</p>
                            ) : (
                              <button
                                onClick={() => setExpandedExplanation(expandedExplanation === r.relationshipId ? null : r.relationshipId)}
                                className="mt-0.5 text-[10px] text-gray-400 hover:text-gray-600"
                              >
                                Why connected?
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {semanticRels.length > 4 && !showAllRelationships && (
                        <button onClick={() => setShowAllRelationships(true)} className="text-[11px] text-purple-600 hover:text-purple-800 mt-1">
                          Show all {semanticRels.length} connections
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Provenance */}
            {object.provenanceSummary && (
              <div>
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">Provenance</p>
                <p className="text-xs text-gray-600">{object.provenanceSummary}</p>
              </div>
            )}

            {hasOverlap && (
              <p className="text-[10px] text-yellow-600 bg-yellow-50 rounded px-2 py-1">
                ⚠ This node overlaps with another topic
              </p>
            )}
          </div>
        )}

        {/* Conversation tab */}
        {activeTab === "conversation" && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Expand toggle */}
            <div className="shrink-0 flex items-center justify-end px-4 pt-2 pb-1">
              <button
                onClick={() => { const next = !conversationExpanded; setConversationExpanded(next); onExpandChange?.(next); }}
                className="text-gray-400 hover:text-gray-600 p-0.5 rounded flex items-center gap-1 text-[10px]"
                title={conversationExpanded ? "Collapse panel" : "Expand panel"}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {conversationExpanded ? (
                    <><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></>
                  ) : (
                    <><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></>
                  )}
                </svg>
                {conversationExpanded ? "Collapse" : "Expand"}
              </button>
            </div>

            {/* Messages — fills remaining space */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
              {loadingMessages && (
                <p className="text-xs text-gray-400 py-4">Loading messages…</p>
              )}
              {!loadingMessages && messages.length === 0 && (
                <p className="text-xs text-gray-400 italic py-4">Source messages not available.</p>
              )}
              {!loadingMessages && messages.length > 0 && (
                <div className="space-y-2">
                  {messages.map((msg, idx) => {
                    const prevMsg = idx > 0 ? messages[idx - 1] : null;
                    const gap = prevMsg ? new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() : 0;
                    const showSeparator = gap > 300000;
                    return (
                      <div key={msg.id}>
                        {showSeparator && (
                          <div className="flex items-center gap-2 py-1">
                            <div className="flex-1 h-px bg-gray-200" />
                            <span className="text-[9px] text-gray-400">Later in conversation</span>
                            <div className="flex-1 h-px bg-gray-200" />
                          </div>
                        )}
                        <div className={`rounded-lg px-3 py-2 text-xs ${
                          msg.role === "user" ? "bg-blue-50 text-gray-800" : "bg-gray-50 text-gray-700"
                        }`}>
                          <span className="text-[10px] font-medium text-gray-400">
                            {msg.role === "user" ? "You" : "Assistant"}
                          </span>
                          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── Sticky footer: Continue / Start conversation ─────────────────── */}
      {onContinue && hasConversationSource && (
        <div className="shrink-0 border-t border-gray-100 p-3">
          <button
            onClick={() => onContinue(object.objectId)}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-purple-700"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            Continue from this node
          </button>
        </div>
      )}
      {onStartConversation && !hasConversationSource && !loadingMessages && (
        <div className="shrink-0 border-t border-gray-100 p-3">
          <button
            onClick={() => onStartConversation(object.objectId)}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-purple-700"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Start a conversation
          </button>
        </div>
      )}
    </div>
  );
}
