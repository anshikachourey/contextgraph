"use client";

import { useState, useRef, useEffect } from "react";
import type { ConversationListItem } from "@/src/lib/db/conversations";
import ConfirmDialog from "@/src/components/ui/ConfirmDialog";

type ConversationSidebarProps = {
  conversations: ConversationListItem[];
  activeConversationId: string | null;
  isCreating: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  archivedConversations: ConversationListItem[];
};

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  isCreating,
  onSelect,
  onNewChat,
  onArchive,
  onRestore,
  onDelete,
  onRename,
  onOpenSettings,
  archivedConversations,
}: ConversationSidebarProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationListItem | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const displayList = showArchived ? archivedConversations : conversations;

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpenId]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  function handleDeleteConfirm() {
    if (deleteTarget) {
      onDelete(deleteTarget.id);
      setDeleteTarget(null);
    }
  }

  function handleRenameStart(conv: ConversationListItem) {
    setMenuOpenId(null);
    setRenamingId(conv.id);
    setRenameValue(conv.title);
  }

  function handleRenameSubmit() {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue("");
  }

  function handleRenameCancel() {
    setRenamingId(null);
    setRenameValue("");
  }

  return (
    <aside className="fixed left-0 top-0 bottom-0 z-30 flex w-[var(--sidebar-width)] flex-col border-r border-[var(--border)] bg-[var(--sidebar-bg)]">
      {/* Brand */}
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2" />
              <circle cx="18" cy="18" r="2" />
              <circle cx="18" cy="6" r="2" />
              <path d="M6 8v8M8 6h8M16 18H8" />
            </svg>
          </div>
          <span className="text-[15px] font-semibold tracking-tight">ContextGraph</span>
        </div>
      </div>

      {/* New chat button */}
      <div className="px-3 pb-3">
        <button
          onClick={onNewChat}
          disabled={isCreating}
          className="focus-ring flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--foreground)] shadow-sm transition-all hover:border-[var(--muted-foreground)]/30 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {isCreating ? "Creating…" : "New conversation"}
        </button>
      </div>

      {/* Active / Archived toggle */}
      <div className="mx-3 mb-2 flex rounded-lg bg-[var(--muted)] p-0.5">
        <button
          onClick={() => setShowArchived(false)}
          className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all ${
            !showArchived
              ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          Active
          <span className="ml-1 text-[11px] opacity-60">{conversations.length}</span>
        </button>
        <button
          onClick={() => setShowArchived(true)}
          className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all ${
            showArchived
              ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          Archived
          <span className="ml-1 text-[11px] opacity-60">{archivedConversations.length}</span>
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {displayList.length === 0 && (
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--muted)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted-foreground)]">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </div>
            <p className="text-[12px] text-[var(--muted-foreground)]">
              {showArchived ? "No archived conversations" : "Start a new conversation"}
            </p>
          </div>
        )}

        {displayList.map((conv) => {
          const isActive = conv.id === activeConversationId;
          const isRenaming = renamingId === conv.id;

          return (
            <div
              key={conv.id}
              className={`group relative mb-0.5 flex items-center rounded-lg transition-all ${
                isActive
                  ? "bg-[var(--accent-light)] border border-[var(--accent)]/10"
                  : "hover:bg-[var(--muted)] border border-transparent"
              }`}
            >
              {isRenaming ? (
                /* Inline rename input */
                <div className="flex-1 px-2 py-1.5">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit();
                      if (e.key === "Escape") handleRenameCancel();
                    }}
                    onBlur={handleRenameSubmit}
                    className="w-full rounded-md border border-[var(--accent)]/30 bg-[var(--surface)] px-2.5 py-1.5 text-[13px] outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                  />
                </div>
              ) : (
                /* Normal conversation row */
                <>
                  <button
                    onClick={() => onSelect(conv.id)}
                    className="flex-1 min-w-0 px-3 py-2.5 text-left"
                  >
                    <span
                      className={`block truncate text-[13px] leading-snug ${
                        isActive
                          ? "font-medium text-[var(--foreground)]"
                          : "text-[var(--foreground)]/80"
                      }`}
                    >
                      {conv.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--muted-foreground)]">
                      {formatRelativeTime(conv.updatedAt || conv.createdAt)}
                    </span>
                  </button>

                  {/* Three-dot menu trigger */}
                  <div className="relative mr-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === conv.id ? null : conv.id);
                      }}
                      className={`rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--foreground)] ${
                        menuOpenId === conv.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`}
                      title="More options"
                      aria-label="Conversation options"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="6" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="18" r="1.5" />
                      </svg>
                    </button>

                    {/* Dropdown menu */}
                    {menuOpenId === conv.id && (
                      <div
                        ref={menuRef}
                        className="absolute right-0 top-8 z-50 w-44 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl shadow-black/10"
                      >
                        {/* Rename */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRenameStart(conv);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
                        >
                          <svg className="w-4 h-4 text-[var(--muted-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          Rename
                        </button>

                        {/* Archive / Unarchive */}
                        {showArchived ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(null);
                              onRestore(conv.id);
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
                          >
                            <svg className="w-4 h-4 text-[var(--muted-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                            </svg>
                            Unarchive
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(null);
                              onArchive(conv.id);
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
                          >
                            <svg className="w-4 h-4 text-[var(--muted-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                            </svg>
                            Archive
                          </button>
                        )}

                        {/* Divider */}
                        <div className="my-1 border-t border-[var(--border)]" />

                        {/* Delete permanently */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(null);
                            setDeleteTarget(conv);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-red-600 transition-colors hover:bg-red-50"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete permanently
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--border)] px-3 py-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          Settings
        </button>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete conversation?"
        description={`"${deleteTarget?.title ?? ""}" will be permanently deleted along with all its messages, nodes, and context graph data. This action cannot be undone.`}
        confirmLabel="Delete permanently"
        cancelLabel="Keep it"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
