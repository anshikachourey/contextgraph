"use client";

import { useState, useEffect, useCallback } from "react";
import Header from "@/src/components/layout/Header";
import ConversationSidebar from "@/src/components/layout/ConversationSidebar";
import ChatPanel from "@/src/components/chat/ChatPanel";
import GraphDrawer from "@/src/components/graph/GraphDrawer";
import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";
import type { SemanticEdge } from "@/src/types/edge";
import type { ChatResponse, ChatErrorResponse } from "@/src/types/ai";
import type { ConversationRouteResponse } from "@/app/api/conversation/route";
import type { ConversationListItem } from "@/src/lib/db/conversations";

export default function Home() {
  // ─── Conversation list state ──────────────────────────────────────────────
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<ConversationListItem[]>([]);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);

  // ─── Active conversation state ────────────────────────────────────────────
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nodes, setNodes] = useState<ContextNode[]>([]);
  const [semanticEdges, setSemanticEdges] = useState<SemanticEdge[]>([]);
  const [isLoadingConversation, setIsLoadingConversation] = useState(true);

  const [isAssistantResponding, setIsAssistantResponding] = useState(false);
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null);

  // Graph summary state
  const [graphSummary, setGraphSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Branch mode state
  const [activeBranchNodeId, setActiveBranchNodeId] = useState<string | null>(null);

  // ─── Load conversation list + initial conversation on mount ────────────────
  useEffect(() => {
    async function init() {
      try {
        // Check URL for a specific conversation to open (used by branch-in-new-tab)
        const urlParams = new URLSearchParams(window.location.search);
        const urlConvId = urlParams.get("conversationId");
        const shouldContinue = urlParams.get("continue") === "true";

        // Fetch conversation list
        const listRes = await fetch("/api/conversations");
        if (listRes.ok) {
          const list = (await listRes.json()) as ConversationListItem[];
          setConversations(list);

          // Also fetch archived conversations
          const archiveRes = await fetch("/api/conversations?archived=true");
          if (archiveRes.ok) {
            const archived = (await archiveRes.json()) as ConversationListItem[];
            setArchivedConversations(archived);
          }

          if (urlConvId) {
            // URL specifies a conversation — load it directly
            await loadConversation(urlConvId);

            // If continue=true, auto-generate assistant for the last user message
            if (shouldContinue) {
              // Small delay to let state settle after loadConversation
              setTimeout(() => continueBranch(urlConvId), 100);
            }
          } else if (list.length > 0) {
            // Load the most recent conversation
            await loadConversation(list[0].id);
          } else {
            // No conversations — create one
            await handleNewChat();
          }
        } else {
          // Fallback: use legacy single-conversation route
          const res = await fetch("/api/conversation");
          if (res.ok) {
            const data = (await res.json()) as ConversationRouteResponse;
            setConversationId(data.conversationId);
            setMessages(data.messages);
            setNodes(data.nodes);
            setSemanticEdges(data.edges);
          }
        }
      } catch {
        // Network failure — UI remains usable but empty
      } finally {
        setIsLoadingConversation(false);
      }
    }

    // Branch continuation: generate assistant for the last user message
    async function continueBranch(branchConvId: string) {
      try {
        // Load the branch messages
        const res = await fetch(`/api/conversation?id=${branchConvId}`);
        if (!res.ok) return;
        const conv = (await res.json()) as ConversationRouteResponse;
        const branchMessages = conv.messages.filter((m) => !m.parentNodeId);

        // Check if the last message is a user message (needs assistant response)
        const lastMsg = branchMessages[branchMessages.length - 1];
        if (!lastMsg || lastMsg.role !== "user") return;

        // Show loading state
        setIsAssistantResponding(true);

        // Generate assistant response
        const chatContext = branchMessages.map((m) => ({ role: m.role, content: m.content }));
        const chatRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: branchConvId, messages: chatContext }),
        });

        if (chatRes.ok) {
          const chatData = (await chatRes.json()) as ChatResponse;
          const assistantMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: chatData.content,
            parentNodeId: null,
            branchRootMessageId: null,
          };

          // Add to UI immediately
          setMessages((prev) => [...prev, assistantMessage]);

          // Persist
          await fetch("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: branchConvId,
              messages: [assistantMessage],
            }),
          });
        }
      } catch {
        // Non-fatal
      } finally {
        setIsAssistantResponding(false);
      }
    }

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Conversation switching ────────────────────────────────────────────────

  const loadConversation = useCallback(async (id: string) => {
    setIsLoadingConversation(true);
    // Reset state for clean switch
    resetConversationState();
    setConversationId(id);

    try {
      const res = await fetch(`/api/conversation?id=${id}`);
      if (!res.ok) {
        console.warn(`[frontend] loadConversation failed: ${res.status}`);
        return;
      }

      const data = (await res.json()) as ConversationRouteResponse;
      console.log(`[frontend] Loaded conversation:`, {
        conversationId: data.conversationId,
        messages: data.messages.length,
        nodes: data.nodes.length,
        edges: data.edges.length,
      });
      setConversationId(data.conversationId);
      setMessages(data.messages);
      setNodes(data.nodes);
      setSemanticEdges(data.edges);
    } catch {
      // Keep empty state on failure
    } finally {
      setIsLoadingConversation(false);
    }
  }, []);

  function resetConversationState() {
    setMessages([]);
    setNodes([]);
    setSemanticEdges([]);
    setActiveNodeId(null);
    setActiveEdgeId(null);
    setActiveBranchNodeId(null);
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setGraphSummary(null);
    setSummaryError(null);
  }

  async function handleSelectConversation(id: string) {
    if (id === conversationId) return;
    await loadConversation(id);
  }

  async function handleNewChat() {
    setIsCreatingConversation(true);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New conversation" }),
      });

      if (!res.ok) return;

      const data = (await res.json()) as { id: string; title: string };

      // Add to list at the top
      const newItem: ConversationListItem = {
        id: data.id,
        title: data.title,
        createdAt: new Date().toISOString(),
        updatedAt: null,
      };
      setConversations((prev) => [newItem, ...prev]);

      // Switch to it
      resetConversationState();
      setConversationId(data.id);
      setIsLoadingConversation(false);
    } catch {
      // Silently fail
    } finally {
      setIsCreatingConversation(false);
    }
  }

  async function handleArchive(id: string) {
    try {
      await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "archive" }),
      });

      // Move from active to archived list
      const conv = conversations.find((c) => c.id === id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conv) setArchivedConversations((prev) => [conv, ...prev]);

      // If we archived the active conversation, switch to another
      if (id === conversationId) {
        const remaining = conversations.filter((c) => c.id !== id);
        if (remaining.length > 0) {
          await loadConversation(remaining[0].id);
        } else {
          await handleNewChat();
        }
      }
    } catch {
      // Silently fail
    }
  }

  async function handleRestore(id: string) {
    try {
      await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "restore" }),
      });

      // Move from archived to active list
      const conv = archivedConversations.find((c) => c.id === id);
      setArchivedConversations((prev) => prev.filter((c) => c.id !== id));
      if (conv) setConversations((prev) => [conv, ...prev]);
    } catch {
      // Silently fail
    }
  }

  // ─── Derived values ────────────────────────────────────────────────────────

  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? null;
  const activeEdge = semanticEdges.find((e) => e.id === activeEdgeId) ?? null;
  const activeNodeMessages = activeNode
    ? messages.filter((m) => activeNode.messageIds.includes(m.id))
    : [];
  const highlightedMessageIds = activeNode?.messageIds ?? [];

  // Branch mode derived
  const activeBranchNode = activeBranchNodeId
    ? (nodes.find((n) => n.id === activeBranchNodeId) ?? null)
    : null;
  const branchLinkedMessages = activeBranchNode
    ? messages.filter((m) => activeBranchNode.messageIds.includes(m.id))
    : [];

  // Messages to display — filtered by mode
  const displayMessages = activeBranchNodeId
    ? messages.filter((m) => m.parentNodeId === activeBranchNodeId)
    : messages.filter((m) => !m.parentNodeId);

  // Continuation counts per node
  const continuationCounts = new Map<string, number>();
  for (const m of messages) {
    if (m.parentNodeId) {
      continuationCounts.set(
        m.parentNodeId,
        (continuationCounts.get(m.parentNodeId) ?? 0) + 1,
      );
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  async function handleEditMessage(messageId: string, newContent: string) {
    console.log("[edit] onEdit invoked", { messageId, newContent: newContent.slice(0, 50) });

    // Determine if this is the latest user message
    const mainThreadMessages = messages.filter((m) => !m.parentNodeId);
    const userMessages = mainThreadMessages.filter((m) => m.role === "user");
    const isLatest = userMessages.length > 0 && userMessages[userMessages.length - 1].id === messageId;

    console.log("[edit] isLatest computed:", {
      isLatest,
      lastUserMsgId: userMessages[userMessages.length - 1]?.id,
      editedMsgId: messageId,
      userMessageCount: userMessages.length,
      mainThreadCount: mainThreadMessages.length,
    });

    if (isLatest) {
      // ─── Case 1: Edit latest user message → regenerate assistant response ──
      console.log("[edit] Taking LATEST path");

      // Update the message content
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, content: newContent } : m)),
      );

      // Persist the edit
      console.log("[edit] Persisting edit to /api/messages/edit...");
      try {
        const editRes = await fetch("/api/messages/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, content: newContent }),
        });
        const editData = await editRes.json();
        console.log("[edit] Persist response:", { status: editRes.status, body: editData });

        if (!editRes.ok) {
          console.error("[edit] Persist FAILED — aborting");
          return;
        }
      } catch (err) {
        console.error("[edit] Persist threw:", err);
        return;
      }

      // Remove the last assistant response (it's now stale)
      const lastAssistant = mainThreadMessages.filter((m) => m.role === "assistant").pop();
      console.log("[edit] Removing stale assistant:", { id: lastAssistant?.id, hasLastAssistant: !!lastAssistant });

      if (lastAssistant) {
        setMessages((prev) => prev.filter((m) => m.id !== lastAssistant.id));
      }

      // Regenerate assistant response with updated conversation
      setIsAssistantResponding(true);
      console.log("[edit] Generating new assistant response...");
      try {
        const updatedHistory = mainThreadMessages
          .filter((m) => m.id !== lastAssistant?.id)
          .map((m) => (m.id === messageId ? { ...m, content: newContent } : m))
          .map((m) => ({ role: m.role, content: m.content }));

        console.log("[edit] Sending to /api/chat with", updatedHistory.length, "messages");

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, messages: updatedHistory }),
        });

        const data = (await response.json()) as ChatResponse | ChatErrorResponse;
        console.log("[edit] /api/chat response:", { status: response.status, hasContent: "content" in data });

        if (!response.ok) throw new Error((data as ChatErrorResponse).error);

        const newAssistant: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: (data as ChatResponse).content,
          parentNodeId: null,
          branchRootMessageId: null,
        };

        setMessages((prev) => [...prev, newAssistant]);
        console.log("[edit] New assistant message added to UI:", { id: newAssistant.id });

        // Persist: delete old assistant, persist new one
        if (conversationId && lastAssistant) {
          console.log("[edit] Deleting old assistant from DB...");
          await fetch("/api/messages/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: lastAssistant.id, action: "delete" }),
          });

          console.log("[edit] Persisting new assistant to DB...");
          await fetch("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              messages: [newAssistant],
            }),
          });
          console.log("[edit] Latest path COMPLETE");
        }
      } catch (err) {
        console.error("[edit] Regeneration failed:", err);
        // Restore the old assistant on failure
        if (lastAssistant) {
          setMessages((prev) => [...prev, lastAssistant]);
        }
      } finally {
        setIsAssistantResponding(false);
      }

    } else {
      // ─── Case 2: Edit earlier message → branch into new tab ────────────────
      // Original conversation is NEVER modified.
      // Optimized: open tab immediately after persist, generate assistant in new tab.
      console.log("[edit] Taking BRANCH path");

      const editIdx = mainThreadMessages.findIndex((m) => m.id === messageId);
      if (editIdx === -1) {
        console.error("[edit] Message not found in mainThread — aborting");
        return;
      }

      // Build branch messages from visible order
      const prefix = mainThreadMessages.slice(0, editIdx);
      const editedUserMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: newContent,
        parentNodeId: null,
        branchRootMessageId: null,
      };
      const branchMessages = [...prefix, editedUserMessage];

      console.table(branchMessages.map((m, i) => ({
        i,
        role: m.role,
        content: m.content.slice(0, 80),
      })));

      try {
        // Derive branch title
        const currentConv = conversations.find((c) => c.id === conversationId);
        const originalTitle = currentConv?.title ?? "Conversation";
        const branchTitle = `Branch · ${originalTitle.slice(0, 50)}`;

        // Create new conversation
        const createRes = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: branchTitle }),
        });
        if (!createRes.ok) return;
        const { id: newConvId } = (await createRes.json()) as { id: string; title: string };

        // Persist prefix + edited user message with fresh IDs
        await fetch("/api/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: newConvId,
            messages: branchMessages,
            freshIds: true,
          }),
        });

        // Open branch tab immediately — it will see the user message and generate assistant
        window.open(`/?conversationId=${newConvId}&continue=true`, "_blank");
        console.log("[edit] Branch tab opened — assistant will generate in new tab");

      } catch (err) {
        console.error("[edit] Branch path failed:", err);
      }
    }
  }

  async function handleSendMessage(content: string) {
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
      let requestBody: Record<string, unknown>;

      if (isBranching) {
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

    // Persist both messages + run engine + refetch graph state
    if (conversationId) {
      // Use async IIFE so we can properly await and catch errors
      (async () => {
        try {
          // 1. Persist messages — engine runs inside this call
          const persistRes = await fetch("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              messages: [userMessage, assistantMessage!],
            }),
          });

          if (persistRes.ok) {
            const persistData = await persistRes.json();
            console.log(`[frontend] Messages persisted, engine result:`, persistData);
          }

          // 2. Refetch full conversation state (engine already ran)
          const res = await fetch(`/api/conversation?id=${conversationId}`);
          if (res.ok) {
            const conv = (await res.json()) as ConversationRouteResponse;
            console.log(`[frontend] Refetch after chat:`, {
              conversationId,
              messages: conv.messages.length,
              nodes: conv.nodes.length,
              edges: conv.edges.length,
            });
            setNodes(conv.nodes);
            setSemanticEdges(conv.edges);
          } else {
            console.warn(`[frontend] Refetch failed: ${res.status} ${res.statusText}`);
          }
        } catch {
          // Non-fatal — graph will update on next interaction or refresh
        }
      })();

      // Update conversation title after first user message (if it's still "New conversation")
      const currentConv = conversations.find((c) => c.id === conversationId);
      if (
        currentConv &&
        currentConv.title === "New conversation" &&
        !isBranching
      ) {
        const derivedTitle = content.slice(0, 40) + (content.length > 40 ? "…" : "");
        fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: conversationId, title: derivedTitle }),
        })
          .then(() => {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === conversationId ? { ...c, title: derivedTitle } : c,
              ),
            );
          })
          .catch(() => {});
      }
    }
  }

  function handleCloseGraph() {
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setActiveNodeId(null);
    setActiveEdgeId(null);
    setGraphSummary(null);
    setSummaryError(null);
  }

  // Branch mode
  function handleBranch(nodeId: string) {
    setActiveBranchNodeId(nodeId);
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setActiveNodeId(null);
    setActiveEdgeId(null);
  }

  function handleExitBranch() {
    setActiveBranchNodeId(null);
  }

  function handleNodeClick(nodeId: string) {
    setActiveEdgeId(null);
    setGraphSummary(null);
    setSummaryError(null);
    setActiveNodeId((current) => (current === nodeId ? null : nodeId));
  }

  function handleEdgeClick(edgeId: string) {
    setActiveNodeId(null);
    setGraphSummary(null);
    setSummaryError(null);
    setActiveEdgeId((current) => (current === edgeId ? null : edgeId));
  }

  function handleClearSelection() {
    setActiveNodeId(null);
    setActiveEdgeId(null);
  }

  // ─── Graph summary ─────────────────────────────────────────────────────────

  async function handleSummarize() {
    setIsSummarizing(true);
    setSummaryError(null);
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

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="relative min-h-screen bg-white text-black">
      <Header onShowGraph={() => setIsGraphOpen(true)} />

      <ConversationSidebar
        conversations={conversations}
        archivedConversations={archivedConversations}
        activeConversationId={conversationId}
        isCreating={isCreatingConversation}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onArchive={handleArchive}
        onRestore={handleRestore}
      />

      {/* Main content — offset for sidebar */}
      <div className="pl-64">
        <ChatPanel
          messages={displayMessages}
          highlightedMessageIds={highlightedMessageIds}
          isAssistantResponding={isAssistantResponding || isLoadingConversation}
          workspaceNode={activeBranchNode}
          workspaceLinkedMessages={branchLinkedMessages}
          onExitWorkspace={handleExitBranch}
          onSendMessage={handleSendMessage}
          onEditMessage={handleEditMessage}
        />
      </div>

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

    </main>
  );
}
