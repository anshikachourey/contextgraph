"use client";

import { useState } from "react";
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
  const [isOriginCollapsed, setIsOriginCollapsed] = useState(false);

  return (
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 pb-10 pt-20">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6 border-b border-gray-200 pb-4">
        <button
          onClick={onBack}
          className="mb-2 flex items-center gap-1 text-sm text-gray-500 transition hover:text-gray-800"
        >
          ← Back to main conversation
        </button>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-900">{node.title}</h1>
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
            Node workspace
          </span>
        </div>
      </div>

      {/* ── Context ────────────────────────────────────────────────────── */}
      {node.summary && (
        <div className="mb-5">
          <p className="text-sm leading-relaxed text-gray-600">{node.summary}</p>
        </div>
      )}

      {/* ── Original Discussion ────────────────────────────────────────── */}
      {linkedMessages.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setIsOriginCollapsed(!isOriginCollapsed)}
            className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600"
          >
            <span className={`transition ${isOriginCollapsed ? "" : "rotate-90"}`}>
              ▸
            </span>
            Original discussion ({linkedMessages.length} message
            {linkedMessages.length === 1 ? "" : "s"})
          </button>

          {!isOriginCollapsed && (
            <div className="space-y-3 border-l-2 border-gray-100 pl-4">
              {linkedMessages.map((message) => (
                <div
                  key={message.id}
                  className="rounded-xl bg-gray-50 px-3 py-2"
                >
                  <p className="mb-0.5 text-xs font-semibold text-gray-400">
                    {message.role === "user" ? "You" : "Assistant"}
                  </p>
                  <p className="text-sm text-gray-700">{message.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Continuation ───────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col justify-end">
        <div className="mb-2">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Continuation
          </p>
        </div>

        <div className="mb-4 space-y-5">
          {/* Empty state */}
          {continuationMessages.length === 0 && !isAssistantResponding && (
            <div className="flex items-center justify-center rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center">
              <p className="text-sm text-gray-400">
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
              onToggle={() => {}}
            />
          ))}

          {/* Typing indicator */}
          {isAssistantResponding && (
            <div className="flex items-center gap-2 rounded-2xl bg-blue-50 px-4 py-3">
              <span className="text-sm font-semibold text-gray-600">
                Assistant
              </span>
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
            </div>
          )}
        </div>

        {/* Input */}
        <ChatInput
          onSendMessage={onSendMessage}
          disabled={isAssistantResponding}
        />
      </div>
    </section>
  );
}
