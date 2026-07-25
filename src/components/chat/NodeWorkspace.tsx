"use client";

import { useState, useRef, useEffect } from "react";
import type { ContextNode } from "@/src/types/node";
import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";

type NodeWorkspaceProps = {
  node: ContextNode;
  linkedMessages: ChatMessageType[];
  continuationMessages: ChatMessageType[];
  isAssistantResponding: boolean;
  onBack: () => void;
  onSendMessage: (content: string) => void;
};

export default function NodeWorkspace({
  node,
  linkedMessages,
  continuationMessages,
  isAssistantResponding,
  onBack,
  onSendMessage,
}: NodeWorkspaceProps) {
  const [isOriginCollapsed, setIsOriginCollapsed] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [continuationMessages.length, isAssistantResponding]);

  return (
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 pb-10 pt-[calc(var(--header-height)+1.5rem)]">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6 border-b border-[var(--border)] pb-4">
        <button
          onClick={onBack}
          className="mb-3 flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-[13px] text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to conversation
        </button>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-[var(--foreground)]">{node.title}</h1>
          <span className="rounded-full bg-[var(--accent-light)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent)]">
            Workspace
          </span>
        </div>
        {node.summary && (
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted-foreground)]">
            {node.summary}
          </p>
        )}
      </div>

      {/* ── Original Discussion ────────────────────────────────────────── */}
      {linkedMessages.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setIsOriginCollapsed(!isOriginCollapsed)}
            className="mb-2 flex items-center gap-2 rounded-lg px-2 py-1 -ml-2 text-[12px] font-medium text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${isOriginCollapsed ? "" : "rotate-90"}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Original discussion ({linkedMessages.length} message
            {linkedMessages.length === 1 ? "" : "s"})
          </button>

          {!isOriginCollapsed && (
            <div className="space-y-2 border-l-2 border-[var(--border)] pl-4 ml-1">
              {linkedMessages.map((message) => (
                <div
                  key={message.id}
                  className="rounded-xl bg-[var(--muted)] px-4 py-3"
                >
                  <p className="mb-1 text-[11px] font-medium text-[var(--muted-foreground)]">
                    {message.role === "user" ? "You" : "ContextGraph"}
                  </p>
                  <p className="text-[13px] leading-relaxed text-[var(--foreground)]/80 line-clamp-4">
                    {message.content}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Continuation ───────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col">
        <div className="mb-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
            Continuation
          </p>
        </div>

        <div className="mb-4 flex-1 space-y-4">
          {/* Empty state */}
          {continuationMessages.length === 0 && !isAssistantResponding && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border)] px-6 py-10 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-light)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--accent)]">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="text-[13px] text-[var(--muted-foreground)]">
                Ask a follow-up to continue this topic.
              </p>
            </div>
          )}

          {/* Continuation messages */}
          {continuationMessages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              isSelected={false}
              isHighlighted={false}
            />
          ))}

          {/* Typing indicator */}
          {isAssistantResponding && (
            <div className="flex items-center gap-3 rounded-2xl bg-[var(--muted)] px-5 py-4">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-light)]">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--accent)]">
                  <circle cx="6" cy="6" r="2" />
                  <circle cx="18" cy="18" r="2" />
                  <path d="M6 8v8M16 18H8" />
                </svg>
              </div>
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
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="sticky bottom-0 bg-gradient-to-t from-[var(--background)] via-[var(--background)] to-transparent pb-5 pt-4">
          <ChatInput
            onSendMessage={onSendMessage}
            disabled={isAssistantResponding}
          />
        </div>
      </div>
    </section>
  );
}
