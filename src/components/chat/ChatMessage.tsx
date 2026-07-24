"use client";

import { useState, useRef, useEffect } from "react";
import type { ChatMessage as ChatMessageType, AttachmentMeta } from "@/src/types/message";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { Components } from "react-markdown";

/**
 * Formats a byte count into a human-readable file size string.
 * e.g., 1024 → "1.0 KB", 2621440 → "2.5 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let size = bytes;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return unitIndex === 0 ? `${size} B` : `${size.toFixed(1)} ${units[unitIndex]}`;
}

/** Renders message attachments: image previews or download links */
function MessageAttachments({ attachments }: { attachments: AttachmentMeta[] }) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-3">
      {attachments.map((attachment, index) => {
        const isImage = attachment.mimeType.startsWith("image/");

        if (isImage) {
          return (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img
                src={attachment.url}
                alt={attachment.filename}
                className="rounded-lg"
                style={{ maxWidth: "400px", height: "auto" }}
              />
            </a>
          );
        }

        return (
          <a
            key={`${attachment.url}-${index}`}
            href={attachment.url}
            download={attachment.filename}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition"
          >
            <svg
              className="h-5 w-5 flex-shrink-0 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
            <span className="truncate max-w-[200px]">{attachment.filename}</span>
            <span className="text-xs text-gray-400">
              ({formatFileSize(attachment.size)})
            </span>
          </a>
        );
      })}
    </div>
  );
}

// Custom CodeBlock component for fenced code blocks
function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : null;
  const isInline = !className && typeof children === "string" && !children.includes("\n");

  if (isInline) {
    return (
      <code
        className="rounded bg-gray-200 px-1.5 py-0.5 text-sm font-mono"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="relative my-3 rounded-lg bg-gray-900 text-gray-100">
      {language && (
        <div className="flex items-center justify-between rounded-t-lg border-b border-gray-700 bg-gray-800 px-4 py-1.5">
          <span className="text-xs font-medium text-gray-400">{language}</span>
        </div>
      )}
      <pre className="overflow-x-auto p-4">
        <code className="text-sm font-mono" {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

// Custom ExternalLink component: opens cross-origin links in new tab
function ExternalLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const isCrossOrigin = (() => {
    if (!href) return false;
    try {
      const linkUrl = new URL(href, window.location.origin);
      return linkUrl.origin !== window.location.origin;
    } catch {
      return false;
    }
  })();

  return (
    <a
      href={href}
      className="text-blue-600 underline hover:text-blue-800"
      {...(isCrossOrigin
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
      {...props}
    >
      {children}
    </a>
  );
}

// Custom components map for ReactMarkdown
const markdownComponents: Components = {
  code: CodeBlock as Components["code"],
  a: ExternalLink as Components["a"],
};

type ChatMessageProps = {
  message: ChatMessageType;
  isSelected?: boolean;
  isHighlighted: boolean;
  onToggle?: (id: string) => void;
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, newContent: string) => void;
  isLatestUserMessage?: boolean;
};

export default function ChatMessage({
  message,
  isSelected = false,
  isHighlighted,
  onRetry,
  onEdit,
  isLatestUserMessage = false,
}: ChatMessageProps) {
  const [showActions, setShowActions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const [originalContent, setOriginalContent] = useState("");
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Debug: track editContent changes
  useEffect(() => {
    console.log("[ChatMessage] editContent changed:", editContent.slice(0, 50));
  }, [editContent]);

  // Debug: track message.content prop changes
  useEffect(() => {
    console.log("[ChatMessage] message.content prop changed:", message.content.slice(0, 50));
  }, [message.content]);

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
    console.log("[ChatMessage] handleEditStart called for message:", message.id);
    setOriginalContent(message.content);
    setEditContent(message.content);
    setIsEditing(true);
    setShowMenu(false);
  }

  function handleEditSave() {
    const trimmed = editContent.trim();

    console.log("[ChatMessage] handleEditSave diagnostic:", {
      trimmed,
      originalContent,
      messageContent: message.content,
      hasOnEdit: !!onEdit,
      trimmedEmpty: !trimmed,
      originalEqualsTrimmed: trimmed === originalContent,
      messageEqualsTrimmed: trimmed === message.content,
    });

    setIsEditing(false);

    if (!trimmed) {
      console.log("[ChatMessage] FAILED: empty");
      return;
    }

    if (!onEdit) {
      console.log("[ChatMessage] FAILED: onEdit missing");
      return;
    }

    if (trimmed === originalContent) {
      console.log("[ChatMessage] FAILED: unchanged");
      return;
    }

    console.log("[ChatMessage] DISPATCHING onEdit");
    onEdit(message.id, trimmed);
  }

  function handleEditCancel() {
    setEditContent(message.content);
    setIsEditing(false);
  }

  // ─── Editing mode ─────────────────────────────────────────────────────────
  if (isEditing) {
    const willBranch = message.role === "user" && !isLatestUserMessage;

    return (
      <div className={`w-full rounded-2xl p-4 text-left bg-gray-100 ring-2 ring-blue-400`}>
        <p className="text-sm font-semibold text-gray-600 mb-2">You</p>
        {willBranch && (
          <p className="mb-2 text-xs text-amber-600 bg-amber-50 rounded px-2 py-1">
            Editing an earlier message will create a new branch.
          </p>
        )}
        <textarea
          ref={textareaRef}
          value={editContent}
          onChange={(e) => {
            console.log("[ChatMessage] textarea onChange:", e.target.value.slice(0, 50));
            setEditContent(e.target.value);
          }}
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
            {willBranch ? "Branch & send" : "Save & regenerate"}
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
      {message.role === "assistant" ? (
        <div className="mt-1 prose prose-sm max-w-none prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-blockquote:my-2 prose-pre:my-0 prose-pre:p-0 prose-pre:bg-transparent">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={markdownComponents}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
      )}

      {/* Render attachments below message content */}
      {message.attachments && message.attachments.length > 0 && (
        <MessageAttachments attachments={message.attachments} />
      )}

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
