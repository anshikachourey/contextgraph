"use client";

import { useState } from "react";
import type { ChatMessage as ChatMessageType } from "@/src/types/message";

type ChatMessageProps = {
  message: ChatMessageType;
  isSelected?: boolean;
  isHighlighted: boolean;
  onToggle?: (id: string) => void;
  onRetry?: (messageId: string) => void;
};

export default function ChatMessage({
  message,
  isSelected = false,
  isHighlighted,
  onRetry,
}: ChatMessageProps) {
  const [showActions, setShowActions] = useState(false);
  const [copied, setCopied] = useState(false);

  const ringClass = isSelected
    ? "ring-2 ring-black"
    : isHighlighted
      ? "ring-2 ring-blue-500 bg-blue-50"
      : message.role === "user"
        ? "bg-gray-100"
        : "bg-blue-50";

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail in some contexts
    }
  }

  return (
    <div
      className={`group relative w-full rounded-2xl p-4 text-left transition ${ringClass}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <p className="text-sm font-semibold text-gray-600">
        {message.role === "user" ? "You" : "Assistant"}
      </p>
      <p className="mt-1 whitespace-pre-wrap">{message.content}</p>

      {/* Action buttons — visible on hover */}
      {showActions && (
        <div className="absolute right-3 top-3 flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
            title="Copy"
          >
            {copied ? (
              <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>

          {message.role === "assistant" && onRetry && (
            <button
              onClick={() => onRetry(message.id)}
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
              title="Retry"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
