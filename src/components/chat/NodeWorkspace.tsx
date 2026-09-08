"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
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
        <div className="mb-3 -ml-1">
          <Button
            variant="ghost"
            size="sm"
            label="Back to conversation"
            onClick={onBack}
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            }
          />
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-[var(--foreground)]">{node.title}</h1>
          <Badge variant="info" label="Workspace" />
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
            <div className="space-y-4 border-l-2 border-[var(--border)] pl-4 ml-1">
              {linkedMessages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  isSelected={false}
                  isHighlighted={false}
                />
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
            <div className="rounded-2xl border border-dashed border-[var(--border)] px-6 py-8">
              <EmptyState
                isCompact
                title="Continue this topic"
                description="Ask a follow-up to continue this topic."
              />
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
