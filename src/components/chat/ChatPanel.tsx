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
}: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);

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

          return (
            <div key={message.id}>
              {showDateSeparator && message.createdAt && (
                <div className="flex items-center justify-center py-4">
                  <div className="rounded-full bg-[var(--muted)] px-3 py-1 text-[11px] font-medium text-[var(--muted-foreground)]">
                    {formatDateSeparator(message.createdAt)}
                  </div>
                </div>
              )}
              <div className="py-2">
                <ChatMessage
                  key={message.id}
                  message={message}
                  isSelected={false}
                  isHighlighted={highlightedMessageIds.includes(message.id)}
                  onEdit={onEditMessage}
                  isLatestUserMessage={isLatestUser}
                />
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
