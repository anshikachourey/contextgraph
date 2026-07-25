"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ChatMessage as ChatMessageType, AttachmentMeta } from "@/src/types/message";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { Components } from "react-markdown";
import ImageLightbox from "@/src/components/ui/ImageLightbox";

/**
 * Formats a byte count into a human-readable file size string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let size = bytes;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return unitIndex === 0 ? `${size} B` : `${size.toFixed(1)} ${units[unitIndex]}`;
}

/** Renders message attachments with lightbox for images */
function MessageAttachments({ attachments }: { attachments: AttachmentMeta[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const imageAttachments = attachments
    .map((a, i) => ({ ...a, originalIndex: i }))
    .filter((a) => a.mimeType.startsWith("image/"));

  return (
    <>
      <div className="mt-3 flex flex-wrap gap-3">
        {attachments.map((attachment, index) => {
          const isImage = attachment.mimeType.startsWith("image/");

          if (isImage) {
            // Find this image's index within the image-only list for lightbox navigation
            const imageIdx = imageAttachments.findIndex((a) => a.originalIndex === index);
            return (
              <button
                key={`${attachment.url}-${index}`}
                type="button"
                onClick={() => setLightboxIndex(imageIdx)}
                className="block overflow-hidden rounded-xl border border-[var(--border)] transition hover:shadow-md hover:border-[var(--accent)]/30 cursor-zoom-in"
              >
                <img
                  src={attachment.url}
                  alt={attachment.filename}
                  className="rounded-xl"
                  style={{ maxWidth: "400px", height: "auto" }}
                />
              </button>
            );
          }

          return (
            <a
              key={`${attachment.url}-${index}`}
              href={attachment.url}
              download={attachment.filename}
              className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--foreground)]/80 transition hover:border-[var(--muted-foreground)]/30 hover:shadow-sm"
            >
              <svg
                className="h-4 w-4 flex-shrink-0 text-[var(--muted-foreground)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="truncate max-w-[200px]">{attachment.filename}</span>
              <span className="text-[11px] text-[var(--muted-foreground)]">
                ({formatFileSize(attachment.size)})
              </span>
            </a>
          );
      })}
    </div>

      {/* Image Lightbox */}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={imageAttachments.map((a) => ({ url: a.url, filename: a.filename }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

/** Code block with copy button and language label */
function CodeBlock({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : null;
  const isInline = !className && typeof children === "string" && !children.includes("\n");

  const handleCopy = useCallback(async () => {
    const text = typeof children === "string" ? children : "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback silently */ }
  }, [children]);

  if (isInline) {
    return (
      <code
        className="rounded-md bg-[var(--muted)] px-1.5 py-0.5 text-[13px] font-mono text-[var(--foreground)]"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl bg-[#1e1e2e] text-gray-100">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              Copied
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-4">
        <code className="text-[13px] leading-relaxed font-mono" {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

/** Link component that opens cross-origin links in new tab */
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
      className="text-[var(--accent)] underline decoration-[var(--accent)]/30 underline-offset-2 transition-colors hover:decoration-[var(--accent)]"
      {...(isCrossOrigin ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...props}
    >
      {children}
    </a>
  );
}

/** Table components for GFM tables */
function Table({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="my-3 overflow-x-auto rounded-lg border border-[var(--border)]">
      <table className="min-w-full text-[13px]" {...props}>
        {children}
      </table>
    </div>
  );
}

function TableHead({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className="bg-[var(--muted)]" {...props}>
      {children}
    </thead>
  );
}

function TableRow({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className="border-b border-[var(--border)] last:border-0" {...props}>
      {children}
    </tr>
  );
}

function TableCell({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className="px-3 py-2 text-[var(--foreground)]" {...props}>
      {children}
    </td>
  );
}

function TableHeaderCell({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className="px-3 py-2 text-left font-medium text-[var(--muted-foreground)]" {...props}>
      {children}
    </th>
  );
}

/** Blockquote with styled left border */
function Blockquote({ children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) {
  return (
    <blockquote
      className="my-3 border-l-3 border-[var(--accent)]/40 pl-4 italic text-[var(--muted-foreground)]"
      {...props}
    >
      {children}
    </blockquote>
  );
}

/** Ordered and unordered lists */
function UnorderedList({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) {
  return (
    <ul className="my-2 ml-4 list-disc space-y-1 marker:text-[var(--muted-foreground)]" {...props}>
      {children}
    </ul>
  );
}

function OrderedList({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) {
  return (
    <ol className="my-2 ml-4 list-decimal space-y-1 marker:text-[var(--muted-foreground)]" {...props}>
      {children}
    </ol>
  );
}

/** Headings with proper sizing */
function H1({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className="mt-5 mb-2 text-[18px] font-bold leading-tight" {...props}>{children}</h1>;
}
function H2({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className="mt-4 mb-2 text-[16px] font-semibold leading-tight" {...props}>{children}</h2>;
}
function H3({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className="mt-3 mb-1.5 text-[15px] font-semibold leading-tight" {...props}>{children}</h3>;
}

/** Horizontal rule */
function HorizontalRule(props: React.HTMLAttributes<HTMLHRElement>) {
  return <hr className="my-4 border-[var(--border)]" {...props} />;
}

const markdownComponents: Components = {
  code: CodeBlock as Components["code"],
  a: ExternalLink as Components["a"],
  table: Table as Components["table"],
  thead: TableHead as Components["thead"],
  tr: TableRow as Components["tr"],
  td: TableCell as Components["td"],
  th: TableHeaderCell as Components["th"],
  blockquote: Blockquote as Components["blockquote"],
  ul: UnorderedList as Components["ul"],
  ol: OrderedList as Components["ol"],
  h1: H1 as Components["h1"],
  h2: H2 as Components["h2"],
  h3: H3 as Components["h3"],
  hr: HorizontalRule as Components["hr"],
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

  const isUser = message.role === "user";

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setShowMenu(false);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* Clipboard may fail */ }
  }

  function handleEditStart() {
    setOriginalContent(message.content);
    setEditContent(message.content);
    setIsEditing(true);
    setShowMenu(false);
  }

  function handleEditSave() {
    const trimmed = editContent.trim();
    setIsEditing(false);
    if (!trimmed || !onEdit || trimmed === originalContent) return;
    onEdit(message.id, trimmed);
  }

  function handleEditCancel() {
    setEditContent(message.content);
    setIsEditing(false);
  }

  // ─── Editing mode ─────────────────────────────────────────────────────────
  if (isEditing) {
    const willBranch = isUser && !isLatestUserMessage;

    return (
      <div className="w-full rounded-2xl border border-[var(--accent)]/20 bg-[var(--muted)] p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] font-medium text-[var(--muted-foreground)]">Editing message</span>
        </div>
        {willBranch && (
          <p className="mb-2.5 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            This will create a new conversation branch.
          </p>
        )}
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
          className="w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[14px] leading-relaxed focus:border-[var(--accent)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/10"
          rows={Math.max(2, editContent.split("\n").length)}
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={handleEditSave}
            className="rounded-lg bg-[var(--foreground)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--background)] transition hover:opacity-90 active:scale-[0.97]"
          >
            {willBranch ? "Branch & send" : "Save & regenerate"}
          </button>
          <button
            onClick={handleEditCancel}
            className="rounded-lg border border-[var(--border)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] transition hover:bg-[var(--muted)]"
          >
            Cancel
          </button>
          <span className="ml-auto text-[11px] text-[var(--muted-foreground)]/60">
            Esc to cancel
          </span>
        </div>
      </div>
    );
  }

  // ─── Normal display ───────────────────────────────────────────────────────
  return (
    <div
      className={`group relative text-left transition-all ${
        isUser ? "flex justify-end" : ""
      }`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowMenu(false); }}
    >
      {isUser ? (
        /* ── User message: right-aligned bubble ── */
        <div
          className={`relative max-w-[85%] rounded-2xl rounded-br-md px-5 py-3.5 ${
            isSelected
              ? "ring-2 ring-[var(--accent)] bg-[var(--accent-light)]"
              : isHighlighted
                ? "ring-2 ring-[var(--accent)]/50 bg-[var(--accent-light)]"
                : "bg-[var(--foreground)] text-[var(--background)]"
          }`}
        >
          <p className="whitespace-pre-wrap text-[14px] leading-[1.7]">{message.content}</p>

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <MessageAttachments attachments={message.attachments} />
          )}

          {/* Copied confirmation */}
          {copied && (
            <span className="absolute -top-7 right-0 rounded-md bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-600 shadow-sm">
              Copied
            </span>
          )}

          {/* Actions */}
          {showActions && (
            <div className="absolute -top-7 right-0" ref={menuRef}>
              <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5 shadow-sm">
                <button
                  onClick={handleEditStart}
                  className="rounded-md p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  title="Edit"
                  aria-label="Edit message"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={handleCopy}
                  className="rounded-md p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  title="Copy"
                  aria-label="Copy message"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── Assistant message: full-width with left accent ── */
        <div
          className={`relative w-full rounded-2xl border-l-[3px] border-[var(--accent)]/30 pl-5 pr-5 py-4 ${
            isSelected
              ? "ring-2 ring-[var(--accent)] bg-[var(--accent-light)]"
              : isHighlighted
                ? "ring-2 ring-[var(--accent)]/50 bg-[var(--accent-light)]"
                : "bg-[var(--surface-raised)]"
          }`}
        >
          {/* Assistant label */}
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--accent-light)]">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--accent)]">
                <circle cx="6" cy="6" r="2" />
                <circle cx="18" cy="18" r="2" />
                <path d="M6 8v8M16 18H8" />
              </svg>
            </div>
            <span className="text-[12px] font-medium text-[var(--muted-foreground)]">ContextGraph</span>
          </div>

          {/* Content */}
          <div className="text-[14px] leading-[1.7] text-[var(--foreground)]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={markdownComponents}
            >
              {message.content}
            </ReactMarkdown>
          </div>

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <MessageAttachments attachments={message.attachments} />
          )}

          {/* Copied confirmation */}
          {copied && (
            <span className="absolute right-4 top-4 rounded-md bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-600">
              Copied
            </span>
          )}

          {/* Actions on hover */}
          {showActions && (
            <div className="absolute right-3 top-3 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
              <button
                onClick={handleCopy}
                className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                title="Copy"
                aria-label="Copy message"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              {onRetry && (
                <button
                  onClick={() => onRetry(message.id)}
                  className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                  title="Retry"
                  aria-label="Retry response"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
