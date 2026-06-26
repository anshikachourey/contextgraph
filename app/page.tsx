"use client";

import { useState, useEffect } from "react";
import Header from "@/src/components/layout/Header";
import ChatPanel from "@/src/components/chat/ChatPanel";
import GraphDrawer from "@/src/components/graph/GraphDrawer";
import CreateNodeModal from "@/src/components/nodes/CreateNodeModal";
import { mockMessages } from "@/src/data/mockMessages";
import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";
import type { SemanticEdge } from "@/src/types/edge";
import type { AiDraft } from "@/src/types/draft";
import type { ChatRequest, ChatResponse, ChatErrorResponse } from "@/src/types/ai";
import type { ConversationRouteResponse } from "@/app/api/conversation/route";
import { checkNodeOverlap } from "@/src/lib/nodeOverlap";
import { AI_DRAFT_CHECK_INTERVAL, AI_DRAFT_CANDIDATE_WINDOW } from "@/src/lib/aiDraftConfig";
import AiDraftNotification from "@/src/components/nodes/AiDraftNotification";

export default function Home() {
  // Conversation is loaded from the DB on mount.
  // Falls back to mockMessages while loading so the UI is never empty.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages);
  const [nodes, setNodes] = useState<ContextNode[]>([]);
  const [semanticEdges, setSemanticEdges] = useState<SemanticEdge[]>([]);
  const [isLoadingConversation, setIsLoadingConversation] = useState(true);

  const [isAssistantResponding, setIsAssistantResponding] = useState(false);
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Nodes that partially overlap the current selection — passed to the modal as a warning
  const [overlappingNodes, setOverlappingNodes] = useState<ContextNode[]>([]);

  // AI Draft state
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
  const [assistantResponseCount, setAssistantResponseCount] = useState(0);
  // When reviewing a draft, open modal with draft values pre-filled
  const [isDraftReview, setIsDraftReview] = useState(false);

  // Graph summary state
  const [graphSummary, setGraphSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Structure conversation state
  const [isStructuring, setIsStructuring] = useState(false);

  // Load conversation from the database on mount
  useEffect(() => {
    async function loadConversation() {
      try {
        const response = await fetch("/api/conversation");
        if (!response.ok) return; // Keep mock data on failure

        const data = (await response.json()) as ConversationRouteResponse;
        setConversationId(data.conversationId);
        setMessages(data.messages);
        setNodes(data.nodes);
        setSemanticEdges(data.edges);
      } catch {
        // Network failure — keep the mock data so the UI remains usable
      } finally {
        setIsLoadingConversation(false);
      }
    }

    loadConversation();
  }, []);

  // Derived values
  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? null;
  const activeEdge = semanticEdges.find((e) => e.id === activeEdgeId) ?? null;
  const activeNodeMessages = activeNode
    ? messages.filter((m) => activeNode.messageIds.includes(m.id))
    : [];
  const highlightedMessageIds = activeNode?.messageIds ?? [];
  const selectedMessages = messages.filter((m) =>
    selectedMessageIds.includes(m.id),
  );

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  }

  async function handleSendMessage(content: string) {
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const updatedMessages = [...messages, userMessage];

    // Optimistic update
    setMessages(updatedMessages);
    setIsAssistantResponding(true);

    let assistantMessage: ChatMessage;

    try {
      // Get assistant reply
      const requestBody: ChatRequest = {
        messages: updatedMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = (await response.json()) as ChatResponse | ChatErrorResponse;

      if (!response.ok) {
        throw new Error(
          (data as ChatErrorResponse).error ?? "Unknown error from /api/chat",
        );
      }

      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: (data as ChatResponse).content,
      };
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "Something went wrong.";
      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Sorry, I couldn't respond right now. (${errorText})`,
      };
    } finally {
      setIsAssistantResponding(false);
    }

    setMessages((current) => [...current, assistantMessage!]);

    // Track assistant response count for AI draft cadence
    const newCount = assistantResponseCount + 1;
    setAssistantResponseCount(newCount);

    // Check if we should generate a draft
    if (newCount % AI_DRAFT_CHECK_INTERVAL === 0) {
      // Fire and forget — don't block the chat UX
      const allMessages = [...updatedMessages, assistantMessage!];
      generateAiDraft(allMessages);
    }

    // Persist both messages — fire and forget
    if (conversationId) {
      fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: [userMessage, assistantMessage!],
        }),
      }).catch(() => {
        // Silently ignore persist failures — conversation is still in memory
      });
    }
  }

  // ─── AI Draft generation ──────────────────────────────────────────────────

  async function generateAiDraft(allMessages: ChatMessage[]) {
    if (!conversationId) return;

    // Take the last N messages as the candidate window
    const candidateMessages = allMessages.slice(-AI_DRAFT_CANDIDATE_WINDOW);

    try {
      const response = await fetch("/api/draft-node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: candidateMessages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.ok) return; // Silently ignore failures

      const data = await response.json();
      if (data.suppressed) return; // Topic already covered by existing node

      setAiDraft({
        title: data.title,
        summary: data.summary,
        candidateMessages,
      });
    } catch {
      // Silently ignore — draft generation is non-critical
    }
  }

  function handleDraftReview() {
    if (!aiDraft) return;
    setIsDraftReview(true);
    setIsModalOpen(true);
  }

  function handleDraftDismiss() {
    setAiDraft(null);
  }

  // ─── Manual node creation ───────────────────────────────────────────────────

  function handleOpenModal() {
    if (selectedMessageIds.length === 0) return;

    const { exactDuplicate, overlappingNodes: overlaps } = checkNodeOverlap(
      selectedMessageIds,
      nodes,
    );

    if (exactDuplicate) {
      setActiveEdgeId(null);
      setActiveNodeId(exactDuplicate.id);
      setIsGraphOpen(true);
      return;
    }

    setOverlappingNodes(overlaps);
    setIsModalOpen(true);
  }

  function handleModalConfirm(title: string, summary: string) {
    // Determine which messages to link — from draft or from manual selection
    const linkedMessageIds = isDraftReview && aiDraft
      ? aiDraft.candidateMessages.map((m) => m.id)
      : selectedMessageIds;

    const linkedMsgs = isDraftReview && aiDraft
      ? aiDraft.candidateMessages
      : selectedMessages;

    const newNode: ContextNode = {
      id: crypto.randomUUID(),
      title,
      summary,
      messageIds: linkedMessageIds,
    };

    // Optimistic update
    setNodes((current) => [...current, newNode]);
    setSelectedMessageIds([]);
    setOverlappingNodes([]);
    setIsModalOpen(false);
    setIsGraphOpen(true);
    setAiDraft(null);
    setIsDraftReview(false);

    // Persist node + auto-compute edges — then refresh state to pick up new edges
    if (conversationId) {
      fetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          node: newNode,
          linkedMessages: linkedMsgs,
          metadata: { createdBy: isDraftReview ? "ai" : "user" },
        }),
      })
        .then((res) => {
          if (res.ok) {
            // Refetch conversation to get updated edges
            return fetch("/api/conversation");
          }
        })
        .then((res) => {
          if (res && res.ok) return res.json();
        })
        .then((data) => {
          if (data) {
            const conv = data as ConversationRouteResponse;
            setNodes(conv.nodes);
            setSemanticEdges(conv.edges);
          }
        })
        .catch(() => {
          // Silently ignore — node was already added optimistically
        });
    }
  }

  function handleModalCancel() {
    setIsModalOpen(false);
    setOverlappingNodes([]);
    setIsDraftReview(false);
    // Don't clear aiDraft on cancel — the notification stays visible
  }

  function handleCloseGraph() {
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setActiveNodeId(null);
    setActiveEdgeId(null);
    setGraphSummary(null);
    setSummaryError(null);
  }

  // Clicking a node clears edge selection and summary, toggle for same node
  function handleNodeClick(nodeId: string) {
    setActiveEdgeId(null);
    setGraphSummary(null);
    setSummaryError(null);
    setActiveNodeId((current) => (current === nodeId ? null : nodeId));
  }

  // Clicking an edge clears node selection and summary, toggle for same edge
  function handleEdgeClick(edgeId: string) {
    setActiveNodeId(null);
    setGraphSummary(null);
    setSummaryError(null);
    setActiveEdgeId((current) => (current === edgeId ? null : edgeId));
  }

  // Close any detail panel
  function handleClearSelection() {
    setActiveNodeId(null);
    setActiveEdgeId(null);
  }

  // ─── Graph summary ──────────────────────────────────────────────────────────

  async function handleSummarize() {
    setIsSummarizing(true);
    setSummaryError(null);
    // Clear node/edge selection so the summary panel takes focus
    setActiveNodeId(null);
    setActiveEdgeId(null);

    try {
      const edgesWithTitles = semanticEdges.map((e) => ({
        sourceTitle: nodes.find((n) => n.id === e.sourceNodeId)?.title ?? "Unknown",
        targetTitle: nodes.find((n) => n.id === e.targetNodeId)?.title ?? "Unknown",
        explanation: e.explanation,
      }));

      const response = await fetch("/api/graph-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes: nodes.map((n) => ({ title: n.title, summary: n.summary })),
          edges: edgesWithTitles,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setSummaryError(data.error ?? "Summary generation failed.");
        return;
      }

      setGraphSummary(data.summary);
    } catch {
      setSummaryError("Network error. Check your connection and try again.");
    } finally {
      setIsSummarizing(false);
    }
  }

  function handleClearSummary() {
    setGraphSummary(null);
    setSummaryError(null);
  }

  // ─── Structure conversation ─────────────────────────────────────────────────

  async function handleStructure() {
    if (!conversationId) return;
    setIsStructuring(true);

    try {
      const response = await fetch("/api/structure-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error ?? "Structuring failed.");
        return;
      }

      const result = data as {
        nodesCreated: number;
        clustersSkipped: number;
        edgesCreated: number;
      };

      console.log(
        `[structure] Created ${result.nodesCreated} nodes, ${result.edgesCreated} edges, skipped ${result.clustersSkipped} clusters`,
      );

      // Refresh conversation to pick up new nodes and edges
      const convResponse = await fetch("/api/conversation");
      if (convResponse.ok) {
        const convData = (await convResponse.json()) as ConversationRouteResponse;
        setNodes(convData.nodes);
        setSemanticEdges(convData.edges);
      }
    } catch {
      alert("Failed to structure conversation. Check if the ML service is running.");
    } finally {
      setIsStructuring(false);
    }
  }

  return (
    <main className="relative min-h-screen bg-white text-black">
      <Header onShowGraph={() => setIsGraphOpen(true)} />

      <ChatPanel
        messages={messages}
        selectedMessageIds={selectedMessageIds}
        highlightedMessageIds={highlightedMessageIds}
        isAssistantResponding={isAssistantResponding || isLoadingConversation}
        onToggleMessage={toggleMessageSelection}
        onCreateNode={handleOpenModal}
        onSendMessage={handleSendMessage}
      />

      {/* AI Draft notification pill */}
      {aiDraft && !isModalOpen && (
        <div className="fixed bottom-24 left-1/2 z-20 -translate-x-1/2">
          <AiDraftNotification
            onReview={handleDraftReview}
            onDismiss={handleDraftDismiss}
          />
        </div>
      )}

      <GraphDrawer
        isOpen={isGraphOpen}
        isMaximized={isGraphMaximized}
        nodes={nodes}
        semanticEdges={semanticEdges}
        hasMessages={messages.length > 0}
        activeNode={activeNode}
        activeNodeMessages={activeNodeMessages}
        activeEdge={activeEdge}
        graphSummary={graphSummary}
        isSummarizing={isSummarizing}
        summaryError={summaryError}
        onSummarize={handleSummarize}
        onClearSummary={handleClearSummary}
        isStructuring={isStructuring}
        onStructure={handleStructure}
        onToggleMaximize={() => setIsGraphMaximized((prev) => !prev)}
        onClose={handleCloseGraph}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onClearSelection={handleClearSelection}
      />

      {isModalOpen && (
        <CreateNodeModal
          selectedMessages={
            isDraftReview && aiDraft ? aiDraft.candidateMessages : selectedMessages
          }
          overlappingNodes={isDraftReview ? [] : overlappingNodes}
          initialTitle={isDraftReview && aiDraft ? aiDraft.title : ""}
          initialSummary={isDraftReview && aiDraft ? aiDraft.summary : ""}
          onConfirm={handleModalConfirm}
          onCancel={handleModalCancel}
        />
      )}
    </main>
  );
}
