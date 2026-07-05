"use client";

import { useState, useRef, useEffect } from "react";
import type { ChatMessage as ChatMessageType } from "@/src/types/message";

type ChatMessageProps = {
  message: ChatMessageType;
  isSelected?: boolean;
  isHighlighted: boolean;
  onToggle?: (id: string) => void;
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, newContent: string) => void;
};

export default function ChatMessage({
  message,
  isSelected = false,
  isHighlighted,
  onRetry,
  onEdit,
}: ChatMessageProps) {
  const [showActions, setShowActions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMenu]);

  // Auto-focus textarea when editing starts
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [isEditing]);

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
      setShowMenu(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail
    }
  }

  function handleEditStart() {
    setEditContent(message.content);
    setIsEditing(true);
    setShowMenu(false);
  }

  function handleEditSave() {
    const trimmed = editContent.trim();
    if (trimmed && trimmed !== message.content && onEdit) {
      onEdit(message.id, trimmed);
    }
    setIsEditing(false);
  }

  function handleEditCancel() {
    setEditContent(message.content);
    setIsEditing(false);
  }

  // ─── Editing mode ─────────────────────────────────────────────────────────
  if (isEditing) {
    return (
      <div className={`w-full rounded-2xl p-4 text-left bg-gray-100 ring-2 ring-blue-400`}>
        <p className="text-sm font-semibold text-gray-600 mb-2">You</p>
        <textarea
          ref={textareaRef}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleEditSave();
            }
            if (e.key === "Escape") handleEditCancel();
          }}
          className="w-full resize-none rounded-lg border border-gray-300 bg-white p-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
          rows={Math.max(2, editContent.split("\n").length)}
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={handleEditSave}
            className="rounded-md bg-black px-3 py-1 text-xs font-medium text-white hover:bg-gray-800"
          >
            Save
          </button>
          <button
            onClick={handleEditCancel}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ─── Normal display ───────────────────────────────────────────────────────
  return (
    <div
      className={`group relative w-full rounded-2xl p-4 text-left transition ${ringClass}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowMenu(false); }}
    >
      <p className="text-sm font-semibold text-gray-600">
        {message.role === "user" ? "You" : "Assistant"}
      </p>
      <p className="mt-1 whitespace-pre-wrap">{message.content}</p>

      {/* Copied confirmation */}
      {copied && (
        <span className="absolute right-3 top-3 text-xs text-green-600 font-medium">Copied!</span>
      )}

      {/* Action buttons — user messages get a three-dot menu */}
      {showActions && message.role === "user" && (
        <div className="absolute right-3 top-3" ref={menuRef}>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
            title="More"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>

          {showMenu && (
            <div className="absolute right-0 top-8 z-50 w-32 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
              <button
                onClick={handleEditStart}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
              <button
                onClick={handleCopy}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy
              </button>
            </div>
          )}
        </div>
      )}

      {/* Assistant messages — copy + retry on hover */}
      {showActions && message.role === "assistant" && (
        <div className="absolute right-3 top-3 flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
            title="Copy"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          {onRetry && (
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
