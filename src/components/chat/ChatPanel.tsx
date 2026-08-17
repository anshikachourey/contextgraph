"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import NodeWorkspace from "./NodeWorkspace";

type ChatPanelProps = {
  messages: ChatMessageType[];
  highlightedMessageIds: string[];
  isAssistantResponding: boolean;
  conversationId?: string | null;
  // Node workspace
  workspaceNode: ContextNode | null;
  workspaceLinkedMessages: ChatMessageType[];
  onExitWorkspace: () => void;
  // Actions
  onSendMessage: (content: string, attachments?: import("@/src/types/message").AttachmentMeta[]) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onCreateNodeFromMessages?: (node: ContextNode, linkedMessages: ChatMessageType[]) => void;
};

/** Format a date into a readable separator label */
function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

/** Check if two message timestamps are on different days */
function isDifferentDay(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const da = new Date(a).toDateString();
  const db = new Date(b).toDateString();
  return da !== db;
}

export default function ChatPanel({
  messages,
  highlightedMessageIds,
  isAssistantResponding,
  conversationId,
  workspaceNode,
  workspaceLinkedMessages,
  onExitWorkspace,
  onSendMessage,
  onEditMessage,
  onCreateNodeFromMessages,
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);

  // ─── Message selection state ────────────────────────────────────────────
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [showCreateNodeModal, setShowCreateNodeModal] = useState(false);
  const [nodeTitle, setNodeTitle] = useState("");
  const [nodeDescription, setNodeDescription] = useState("");
  const [isCreatingNode, setIsCreatingNode] = useState(false);

  const toggleMessageSelection = useCallback((id: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const handleCreateNodeConfirm = useCallback(async () => {
    if (!nodeTitle.trim() || selectedMessageIds.size === 0) return;

    const selectedMessages = messages.filter((m) => selectedMessageIds.has(m.id));
    const node: ContextNode = {
      id: crypto.randomUUID(),
      title: nodeTitle.trim(),
      summary: nodeDescription.trim(),
      messageIds: selectedMessages.map((m) => m.id),
    };

    setIsCreatingNode(true);

    try {
      // Persist to the V2 Knowledge Map via the manual-node endpoint
      if (conversationId) {
        const res = await fetch("/api/v2/manual-node", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            title: node.title,
            description: node.summary,
            messageIds: node.messageIds,
          }),
        });
        if (!res.ok) {
          console.error("[ChatPanel] Failed to persist manual node:", await res.text());
        }
      }

      // Notify parent to open the Knowledge Map
      onCreateNodeFromMessages?.(node, selectedMessages);
    } finally {
      setIsCreatingNode(false);
      setShowCreateNodeModal(false);
      setNodeTitle("");
      setNodeDescription("");
      exitSelectMode();
    }
  }, [nodeTitle, nodeDescription, selectedMessageIds, messages, conversationId, onCreateNodeFromMessages, exitSelectMode]);

  // Auto-scroll to bottom on new messages (if user is near bottom)
  useEffect(() => {
    if (isNearBottom && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isAssistantResponding, isNearBottom]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom < 120;
    setIsNearBottom(nearBottom);
    setShowScrollButton(!nearBottom && messages.length > 5);
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // If a workspace node is active, render the focused workspace view
  if (workspaceNode) {
    return (
      <NodeWorkspace
        node={workspaceNode}
        linkedMessages={workspaceLinkedMessages}
        continuationMessages={messages}
        isAssistantResponding={isAssistantResponding}
        onBack={onExitWorkspace}
        onSendMessage={onSendMessage}
      />
    );
  }

  // Loading state
  if (!conversationId) {
    return (
      <section className="mx-auto flex h-screen max-w-3xl flex-col px-6 pt-[calc(var(--header-height)+2rem)]">
        <div className="flex flex-1 flex-col items-center justify-center">
          <LoadingSkeleton />
        </div>
      </section>
    );
  }

  // Empty state — no messages yet
  if (messages.length === 0 && !isAssistantResponding) {
    return (
      <section className="mx-auto flex h-screen max-w-3xl flex-col px-6 pt-[calc(var(--header-height)+2rem)]">
        <div className="flex flex-1 flex-col items-center justify-center pb-32">
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-lg shadow-[var(--accent)]/20">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2" />
              <circle cx="18" cy="18" r="2" />
              <circle cx="18" cy="6" r="2" />
              <path d="M6 8v8M8 6h8M16 18H8" />
            </svg>
          </div>
          <h2 className="mb-2 text-xl font-semibold tracking-tight text-[var(--foreground)]">
            Start a conversation
          </h2>
          <p className="mb-8 max-w-sm text-center text-[14px] leading-relaxed text-[var(--muted-foreground)]">
            ContextGraph builds a knowledge graph from your conversations, giving AI persistent memory across sessions.
          </p>
          <div className="grid w-full max-w-md grid-cols-2 gap-2">
            {[
              { icon: "💡", label: "Explore an idea", prompt: "I want to explore an idea — " },
              { icon: "📝", label: "Plan a project", prompt: "Help me plan a project for " },
              { icon: "🔬", label: "Deep-dive a topic", prompt: "I want to deep-dive into " },
              { icon: "🧩", label: "Solve a problem", prompt: "I need help solving " },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => onSendMessage(item.prompt)}
                className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-[13px] text-[var(--foreground)] transition-all hover:border-[var(--muted-foreground)]/30 hover:shadow-sm active:scale-[0.98]"
              >
                <span className="text-base">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Input — always visible at the bottom */}
        <div className="sticky bottom-0 bg-[var(--background)] pb-6 pt-2">
          <ChatInput
            onSendMessage={onSendMessage}
            disabled={isAssistantResponding}
            conversationId={conversationId}
          />
        </div>
      </section>
    );
  }

  // Normal conversation view
  return (
    <section className="relative flex h-screen flex-col pt-[calc(var(--header-height)+0.5rem)]">
      {/* Select mode toggle */}
      {!isSelectMode && messages.length > 0 && (
        <div className="absolute top-[calc(var(--header-height)+0.75rem)] right-6 z-10">
          <button
            onClick={() => setIsSelectMode(true)}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] shadow-sm transition-all hover:border-[var(--muted-foreground)]/30 hover:text-[var(--foreground)] hover:shadow-md"
            title="Select messages to create a node"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
            Select
          </button>
        </div>
      )}

      {/* Message list — scrollable, full width so scrollbar sits at screen edge */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scroll-smooth"
      >
        <div className="mx-auto max-w-3xl space-y-1 px-6 pb-4">
        {messages.map((message, idx) => {
          const userMessages = messages.filter((m) => m.role === "user");
          const isLatestUser =
            message.role === "user" &&
            userMessages.length > 0 &&
            userMessages[userMessages.length - 1].id === message.id;

          // Date separator
          const prevMessage = idx > 0 ? messages[idx - 1] : null;
          const showDateSeparator =
            message.createdAt &&
            (idx === 0 || isDifferentDay(prevMessage?.createdAt, message.createdAt));

          const isMessageSelected = selectedMessageIds.has(message.id);

          return (
            <div key={message.id}>
              {showDateSeparator && message.createdAt && (
                <div className="flex items-center justify-center py-4">
                  <div className="rounded-full bg-[var(--muted)] px-3 py-1 text-[11px] font-medium text-[var(--muted-foreground)]">
                    {formatDateSeparator(message.createdAt)}
                  </div>
                </div>
              )}
              <div className={`py-2 flex items-start gap-2 ${isSelectMode ? "cursor-pointer" : ""}`}
                onClick={isSelectMode ? () => toggleMessageSelection(message.id) : undefined}
              >
                {/* Selection checkbox */}
                {isSelectMode && (
                  <div className="flex-shrink-0 pt-3">
                    <div className={`flex h-5 w-5 items-center justify-center rounded-md border-2 transition-all ${
                      isMessageSelected
                        ? "border-[var(--accent)] bg-[var(--accent)]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}>
                      {isMessageSelected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  </div>
                )}
                <div className={`flex-1 min-w-0 rounded-xl transition-all ${
                  isSelectMode && isMessageSelected ? "ring-2 ring-[var(--accent)]/30 bg-[var(--accent-light)]/30" : ""
                }`}>
                  <ChatMessage
                    key={message.id}
                    message={message}
                    isSelected={isMessageSelected}
                    isHighlighted={highlightedMessageIds.includes(message.id)}
                    onEdit={isSelectMode ? undefined : onEditMessage}
                    isLatestUserMessage={isLatestUser}
                  />
                </div>
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {isAssistantResponding && messages.length > 0 && messages[messages.length - 1]?.content === "" && (
          <div className="py-2">
            <StreamingIndicator />
          </div>
        )}

        {/* Typing indicator (when waiting for first token) */}
        {isAssistantResponding && (messages.length === 0 || messages[messages.length - 1]?.content !== "") && (
          <div className="py-2">
            <div className="flex items-center gap-3 rounded-2xl bg-[var(--muted)] px-5 py-4">
              <AssistantAvatar />
              <span className="flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="inline-block h-2 w-2 rounded-full bg-[var(--muted-foreground)]/50 animate-pulse-dot"
                    style={{ animationDelay: `${i * 200}ms` }}
                  />
                ))}
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* ─── Floating selection action bar ─────────────────────────────────── */}
      {isSelectMode && (
        <div className="absolute bottom-28 left-1/2 z-20 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-3 shadow-xl">
            <span className="text-[13px] font-medium text-[var(--foreground)]">
              {selectedMessageIds.size} selected
            </span>
            <div className="h-4 w-px bg-[var(--border)]" />
            <button
              onClick={() => {
                if (selectedMessageIds.size > 0) {
                  setShowCreateNodeModal(true);
                }
              }}
              disabled={selectedMessageIds.size === 0}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Create Node
            </button>
            <button
              onClick={exitSelectMode}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Scroll to bottom FAB */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-24 right-8 flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-lg transition-all hover:shadow-xl hover:scale-105 active:scale-95"
          aria-label="Scroll to bottom"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--foreground)]">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}

      {/* Input — sticky at the bottom */}
      <div className="bg-gradient-to-t from-[var(--background)] via-[var(--background)] to-transparent pb-5 pt-4">
        <div className="mx-auto max-w-3xl px-6">
          <ChatInput
            onSendMessage={onSendMessage}
            disabled={isAssistantResponding}
            conversationId={conversationId}
          />
        </div>
      </div>

      {/* ─── Create Node confirmation modal ────────────────────────────────── */}
      {showCreateNodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            onClick={() => setShowCreateNodeModal(false)}
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
            <h2 className="text-[16px] font-semibold text-[var(--foreground)]">
              Create Node from Messages
            </h2>
            <p className="mt-1 text-[13px] text-[var(--muted-foreground)]">
              {selectedMessageIds.size} message{selectedMessageIds.size > 1 ? "s" : ""} selected. This will create a manual node linked to the selected messages.
            </p>

            {/* Preview of selected messages */}
            <div className="mt-3 max-h-32 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3 space-y-1.5">
              {messages
                .filter((m) => selectedMessageIds.has(m.id))
                .map((m) => (
                  <div key={m.id} className="flex items-start gap-2 text-[12px]">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                      m.role === "user"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                        : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                    }`}>
                      {m.role === "user" ? "You" : "AI"}
                    </span>
                    <span className="text-[var(--muted-foreground)] line-clamp-2">
                      {m.content.slice(0, 120)}{m.content.length > 120 ? "…" : ""}
                    </span>
                  </div>
                ))}
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="text-[12px] font-medium text-[var(--foreground)]">
                  Node Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={nodeTitle}
                  onChange={(e) => setNodeTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleCreateNodeConfirm()}
                  placeholder="e.g. Project Requirements Discussion"
                  autoFocus
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                />
              </div>
              <div>
                <label className="text-[12px] font-medium text-[var(--foreground)]">
                  Summary
                </label>
                <textarea
                  value={nodeDescription}
                  onChange={(e) => setNodeDescription(e.target.value)}
                  placeholder="Optional summary of what these messages cover..."
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 resize-none"
                />
              </div>
            </div>

            <div className="mt-3 rounded-lg bg-[var(--accent-light)] px-3 py-2">
              <p className="text-[11px] text-[var(--accent)]">
                <span className="font-medium">Provenance:</span> USER_CREATED — This node will be marked as manually created and will not be treated as SIE-generated semantic truth.
              </p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowCreateNodeModal(false)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateNodeConfirm}
                disabled={!nodeTitle.trim() || isCreatingNode}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreatingNode ? "Creating…" : "Create Node"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Small branded avatar for the assistant */
function AssistantAvatar() {
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-light)]">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--accent)]">
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M6 8v8M16 18H8" />
      </svg>
    </div>
  );
}

/** Streaming indicator — shows while content is actively arriving */
function StreamingIndicator() {
  return (
    <div className="flex items-center gap-2 px-5 py-2">
      <div className="h-1 w-1 rounded-full bg-[var(--accent)] animate-pulse-dot" />
      <span className="text-[11px] font-medium text-[var(--muted-foreground)]">Generating…</span>
    </div>
  );
}

/** Loading skeleton for initial conversation load */
function LoadingSkeleton() {
  return (
    <div className="w-full max-w-2xl space-y-6 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className={`flex ${i % 2 === 0 ? "justify-start" : "justify-start"}`}>
          <div className="w-full space-y-2 rounded-2xl bg-[var(--muted)] p-5">
            <div className="h-3 w-16 rounded bg-[var(--border)]" />
            <div className="space-y-1.5">
              <div className="h-3 w-full rounded bg-[var(--border)]" />
              <div className="h-3 w-4/5 rounded bg-[var(--border)]" />
              {i === 2 && <div className="h-3 w-3/5 rounded bg-[var(--border)]" />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
