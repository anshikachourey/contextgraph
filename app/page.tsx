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
import type { ChatResponse, ChatErrorResponse } from "@/src/types/ai";
import type { ConversationRouteResponse } from "@/app/api/conversation/route";
import { checkNodeOverlap } from "@/src/lib/nodeOverlap";

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

  // Graph summary state
  const [graphSummary, setGraphSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Structure conversation state — replaced by automatic graph engine
  // (kept as unused vars won't break tsc, but remove the handlers)

  // Branch mode state
  const [activeBranchNodeId, setActiveBranchNodeId] = useState<string | null>(null);

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
  // Branch mode derived
  const activeBranchNode = activeBranchNodeId
    ? (nodes.find((n) => n.id === activeBranchNodeId) ?? null)
    : null;
  const branchNodeTitle = activeBranchNode?.title ?? null;
  const branchNodeSummary = activeBranchNode?.summary ?? null;
  const branchLinkedMessages = activeBranchNode
    ? messages.filter((m) => activeBranchNode.messageIds.includes(m.id))
    : [];

  // Messages to display — filtered by mode
  const displayMessages = activeBranchNodeId
    ? messages.filter((m) => m.parentNodeId === activeBranchNodeId)
    : messages.filter((m) => !m.parentNodeId);

  // Continuation counts per node (derived from all messages, no extra queries)
  const continuationCounts = new Map<string, number>();
  for (const m of messages) {
    if (m.parentNodeId) {
      continuationCounts.set(
        m.parentNodeId,
        (continuationCounts.get(m.parentNodeId) ?? 0) + 1,
      );
    }
  }

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  }

  async function handleSendMessage(content: string) {
    // Determine if we're in branch mode
    const isBranching = activeBranchNodeId !== null && activeBranchNode !== null;
    const branchRootId = isBranching ? crypto.randomUUID() : undefined;

    const userMessage: ChatMessage = {
      id: branchRootId ?? crypto.randomUUID(),
      role: "user",
      content,
      parentNodeId: isBranching ? activeBranchNodeId : null,
      branchRootMessageId: isBranching ? branchRootId : null,
    };
    const updatedMessages = [...messages, userMessage];

    // Optimistic update
    setMessages(updatedMessages);
    setIsAssistantResponding(true);

    let assistantMessage: ChatMessage;

    try {
      // Build request — different context for branch vs normal mode
      let requestBody: Record<string, unknown>;

      if (isBranching) {
        // Branch mode: send node context + prior branch messages + new message
        const priorBranchMessages = messages
          .filter((m) => m.parentNodeId === activeBranchNodeId)
          .map((m) => ({ role: m.role, content: m.content }));

        const linkedMsgs = messages
          .filter((m) => activeBranchNode!.messageIds.includes(m.id))
          .map((m) => ({ role: m.role, content: m.content }));

        requestBody = {
          messages: [...priorBranchMessages, { role: "user", content }],
          branchContext: {
            nodeTitle: activeBranchNode!.title,
            nodeSummary: activeBranchNode!.summary,
            linkedMessages: linkedMsgs,
          },
        };
      } else {
        // Normal mode: full conversation history
        requestBody = {
          conversationId,
          messages: updatedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        };
      }

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
        parentNodeId: isBranching ? activeBranchNodeId : null,
        branchRootMessageId: isBranching ? branchRootId : null,
      };
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "Something went wrong.";
      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Sorry, I couldn't respond right now. (${errorText})`,
        parentNodeId: isBranching ? activeBranchNodeId : null,
        branchRootMessageId: isBranching ? branchRootId : null,
      };
    } finally {
      setIsAssistantResponding(false);
    }

    setMessages((current) => [...current, assistantMessage!]);

    // Persist both messages — fire and forget
    if (conversationId) {
      fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: [userMessage, assistantMessage!],
        }),
      })
        .then(() => {
          // Graph engine already ran inside /api/chat — just refetch to pick up changes
          return fetch("/api/conversation");
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
          // Silently ignore — refetch failure is non-fatal
        });
    }
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
    const newNode: ContextNode = {
      id: crypto.randomUUID(),
      title,
      summary,
      messageIds: selectedMessageIds,
    };

    // Optimistic update
    setNodes((current) => [...current, newNode]);
    setSelectedMessageIds([]);
    setOverlappingNodes([]);
    setIsModalOpen(false);
    setIsGraphOpen(true);

    // Persist node + auto-compute edges — then refresh state to pick up new edges
    if (conversationId) {
      fetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          node: newNode,
          linkedMessages: selectedMessages,
          metadata: { createdBy: "user" },
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
  }

  function handleCloseGraph() {
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setActiveNodeId(null);
    setActiveEdgeId(null);
    setGraphSummary(null);
    setSummaryError(null);
  }

  // Branch mode — enter/exit
  function handleBranch(nodeId: string) {
    setActiveBranchNodeId(nodeId);
    // Close the graph drawer so the user focuses on the chat
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setActiveNodeId(null);
    setActiveEdgeId(null);
  }

  function handleExitBranch() {
    setActiveBranchNodeId(null);
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

  return (
    <main className="relative min-h-screen bg-white text-black">
      <Header onShowGraph={() => setIsGraphOpen(true)} />

      <ChatPanel
        messages={displayMessages}
        selectedMessageIds={selectedMessageIds}
        highlightedMessageIds={highlightedMessageIds}
        isAssistantResponding={isAssistantResponding || isLoadingConversation}
        workspaceNode={activeBranchNode}
        workspaceLinkedMessages={branchLinkedMessages}
        onExitWorkspace={handleExitBranch}
        onToggleMessage={toggleMessageSelection}
        onCreateNode={handleOpenModal}
        onSendMessage={handleSendMessage}
      />

      <GraphDrawer
        isOpen={isGraphOpen}
        isMaximized={isGraphMaximized}
        nodes={nodes}
        semanticEdges={semanticEdges}
        continuationCounts={continuationCounts}
        activeNode={activeNode}
        activeNodeMessages={activeNodeMessages}
        activeEdge={activeEdge}
        graphSummary={graphSummary}
        isSummarizing={isSummarizing}
        summaryError={summaryError}
        onSummarize={handleSummarize}
        onClearSummary={handleClearSummary}
        onBranch={handleBranch}
        onToggleMaximize={() => setIsGraphMaximized((prev) => !prev)}
        onClose={handleCloseGraph}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onClearSelection={handleClearSelection}
      />

      {isModalOpen && (
        <CreateNodeModal
          selectedMessages={selectedMessages}
          overlappingNodes={overlappingNodes}
          onConfirm={handleModalConfirm}
          onCancel={handleModalCancel}
        />
      )}
    </main>
  );
}
