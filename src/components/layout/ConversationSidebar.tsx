"use client";

import { useState, useEffect } from "react";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Button } from "@astryxdesign/core/Button";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Icon } from "@astryxdesign/core/Icon";
import type { ConversationListItem } from "@/src/lib/db/conversations";
import ConfirmDialog from "@/src/components/ui/ConfirmDialog";

type ConversationSidebarProps = {
  conversations: ConversationListItem[];
  activeConversationId: string | null;
  isCreating: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  archivedConversations: ConversationListItem[];
};

/** Brand mark glyph (matches the app's graph identity). */
function BrandGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 8v8M8 6h8M16 18H8" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function GraphDashboardGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="19" cy="14" r="2" />
      <path d="M5 8v6a2 2 0 002 2h3" />
      <path d="M19 8v4" />
      <path d="M14 18h3a2 2 0 002-2" />
      <path d="M7 6h10" />
    </svg>
  );
}

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  isCreating,
  isOpen,
  onClose,
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const displayList = showArchived ? archivedConversations : conversations;

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // (Body-scroll locking on mobile is now handled by AppShell's modal drawer,
  // which hosts this rail below its breakpoint.)

  // On mobile, close sidebar after selecting a conversation
  function handleSelect(id: string) {
    onSelect(id);
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    if (isMobile) onClose();
  }

  function handleRenameStart(conv: ConversationListItem) {
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
    <>
      {/* Rail is placed in AppShell's sideNav slot, so it flows in the shell's
          own layout region (no fixed positioning or manual offset). AppShell
          owns width and content offset. */}
      <div className="flex h-full w-[var(--sidebar-width)] flex-col">
        <SideNav
          header={<SideNavHeading heading="ContextGraph" icon={<BrandGlyph />} />}
          topContent={
            <div className="px-2 pb-1">
              <Button
                variant="secondary"
                label={isCreating ? "Creating…" : "New conversation"}
                icon={<PlusGlyph />}
                width="100%"
                isDisabled={isCreating}
                onClick={onNewChat}
              />
              <div className="mt-2">
                <TabList
                  value={showArchived ? "archived" : "active"}
                  onChange={(v) => setShowArchived(v === "archived")}
                  layout="fill"
                  size="sm"
                >
                  <Tab value="active" label={`Active (${conversations.length})`} />
                  <Tab value="archived" label={`Archived (${archivedConversations.length})`} />
                </TabList>
              </div>
            </div>
          }
          footer={
            <div className="flex flex-col gap-0.5">
              <SideNavItem
                as="a"
                href="/graph-dashboard"
                label="Graph Dashboard"
                icon={<GraphDashboardGlyph />}
                size="sm"
              />
              <SideNavItem
                label="Settings"
                icon={<Icon icon="wrench" />}
                size="sm"
                onClick={onOpenSettings}
              />
            </div>
          }
        >
          <SideNavSection title={showArchived ? "Archived" : "Conversations"} isHeaderHidden>
            {displayList.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-[var(--muted-foreground)]">
                {showArchived ? "No archived conversations" : "Start a new conversation"}
              </p>
            ) : (
              displayList.map((conv) => {
                if (renamingId === conv.id) {
                  return (
                    <div key={conv.id} className="px-2 py-1">
                      <TextInput
                        label="Rename conversation"
                        isLabelHidden
                        value={renameValue}
                        onChange={setRenameValue}
                        onEnter={handleRenameSubmit}
                        onKeyDown={(e) => { if (e.key === "Escape") handleRenameCancel(); }}
                        hasAutoFocus
                        size="sm"
                      />
                    </div>
                  );
                }

                const menuItems = [
                  { label: "Rename", onClick: () => handleRenameStart(conv) },
                  showArchived
                    ? { label: "Unarchive", onClick: () => onRestore(conv.id) }
                    : { label: "Archive", onClick: () => onArchive(conv.id) },
                  { type: "divider" as const },
                  {
                    label: "Delete permanently",
                    variant: "destructive" as const,
                    onClick: () => setDeleteTarget(conv),
                  },
                ];

                return (
                  <SideNavItem
                    key={conv.id}
                    label={conv.title}
                    isSelected={conv.id === activeConversationId}
                    onClick={() => handleSelect(conv.id)}
                    endContent={
                      <span className="text-[11px] text-[var(--muted-foreground)]">
                        {formatRelativeTime(conv.updatedAt || conv.createdAt)}
                      </span>
                    }
                    actions={
                      <MoreMenu
                        label="Conversation options"
                        size="sm"
                        alignment="end"
                        items={menuItems}
                      />
                    }
                  />
                );
              })
            )}
          </SideNavSection>
        </SideNav>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete conversation?"
        description={`"${deleteTarget?.title ?? ""}" will be permanently deleted along with all its messages, nodes, and context graph data. This action cannot be undone.`}
        confirmLabel="Delete permanently"
        cancelLabel="Keep it"
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) {
            onDelete(deleteTarget.id);
            setDeleteTarget(null);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
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
