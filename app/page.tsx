"use client";

import { useState, useEffect } from "react";
import Header from "@/src/components/layout/Header";
import ChatPanel from "@/src/components/chat/ChatPanel";
import GraphDrawer from "@/src/components/graph/GraphDrawer";
import CreateNodeModal from "@/src/components/nodes/CreateNodeModal";
import { mockMessages } from "@/src/data/mockMessages";
import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";
import type { ChatRequest, ChatResponse, ChatErrorResponse } from "@/src/types/ai";
import type { ConversationRouteResponse } from "@/app/api/conversation/route";
import { checkNodeOverlap } from "@/src/lib/nodeOverlap";

export default function Home() {
  // Conversation is loaded from the DB on mount.
  // Falls back to mockMessages while loading so the UI is never empty.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages);
  const [nodes, setNodes] = useState<ContextNode[]>([]);
  const [isLoadingConversation, setIsLoadingConversation] = useState(true);

  const [isAssistantResponding, setIsAssistantResponding] = useState(false);
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Nodes that partially overlap the current selection — passed to the modal as a warning
  const [overlappingNodes, setOverlappingNodes] = useState<ContextNode[]>([]);

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

  function handleOpenModal() {
    if (selectedMessageIds.length === 0) return;

    const { exactDuplicate, overlappingNodes: overlaps } = checkNodeOverlap(
      selectedMessageIds,
      nodes,
    );

    if (exactDuplicate) {
      // Don't open the modal — the user is recreating an existing topic exactly.
      // Open the graph and focus the duplicate node so they can see it.
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

    // Persist node — fire and forget
    if (conversationId) {
      fetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          node: newNode,
          // Pass the actual message objects so the API can generate evidence summary
          linkedMessages: selectedMessages,
          metadata: { createdBy: "user" },
        }),
      }).catch(() => {
        // Silently ignore persist failures
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
  }

  function handleNodeClick(nodeId: string) {
    setActiveNodeId((current) => (current === nodeId ? null : nodeId));
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

      <GraphDrawer
        isOpen={isGraphOpen}
        isMaximized={isGraphMaximized}
        nodes={nodes}
        activeNode={activeNode}
        activeNodeMessages={activeNodeMessages}
        onToggleMaximize={() => setIsGraphMaximized((prev) => !prev)}
        onClose={handleCloseGraph}
        onNodeClick={handleNodeClick}
        onClearActiveNode={() => setActiveNodeId(null)}
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
