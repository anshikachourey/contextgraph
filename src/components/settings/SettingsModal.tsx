"use client";

import { useState } from "react";
import type { ThemeMode } from "@/src/hooks/useTheme";
import type { ConversationListItem } from "@/src/lib/db/conversations";
import ConfirmDialog from "@/src/components/ui/ConfirmDialog";

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  // Appearance
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  // Archived conversations
  archivedConversations: ConversationListItem[];
  onRestoreConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  // Data
  allConversationCount: number;
  onDeleteAllData: () => void;
};

type SettingsSection = "appearance" | "archived" | "data";

export default function SettingsModal({
  isOpen,
  onClose,
  themeMode,
  onThemeChange,
  archivedConversations,
  onRestoreConversation,
  onDeleteConversation,
  allConversationCount,
  onDeleteAllData,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("appearance");
  const [deleteTarget, setDeleteTarget] = useState<ConversationListItem | null>(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);

  if (!isOpen) return null;

  const sections: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
    {
      id: "appearance",
      label: "Appearance",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ),
    },
    {
      id: "archived",
      label: "Archived",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
      ),
    },
    {
      id: "data",
      label: "Data & Privacy",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      ),
    },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
        <div
          className="flex w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/15"
          style={{ maxHeight: "min(600px, 85vh)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Content area */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
              <h3 className="text-[15px] font-semibold text-[var(--foreground)]">
                {sections.find((s) => s.id === activeSection)?.label}
              </h3>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                aria-label="Close settings"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {activeSection === "appearance" && (
                <AppearanceSection mode={themeMode} onChange={onThemeChange} />
              )}
              {activeSection === "archived" && (
                <ArchivedSection
                  conversations={archivedConversations}
                  onRestore={onRestoreConversation}
                  onDelete={(conv) => setDeleteTarget(conv)}
                />
              )}
              {activeSection === "data" && (
                <DataSection
                  conversationCount={allConversationCount}
                  onDeleteAll={() => setShowDeleteAllConfirm(true)}
                />
              )}
            </div>
          </div>

          {/* Sidebar navigation — right side */}
          <nav className="flex w-48 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--muted)] py-4">
            <h2 className="mb-3 px-4 text-[13px] font-semibold text-[var(--foreground)]">
              Settings
            </h2>
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`mx-2 mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                  activeSection === section.id
                    ? "bg-[var(--surface)] text-[var(--foreground)] font-medium shadow-sm"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--surface)]/50"
                }`}
              >
                {section.icon}
                {section.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Delete single conversation confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete conversation?"
        description={`"${deleteTarget?.title ?? ""}" will be permanently deleted along with all its messages, nodes, and context graph data. This cannot be undone.`}
        confirmLabel="Delete permanently"
        cancelLabel="Keep it"
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) onDeleteConversation(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Delete all data confirmation */}
      <ConfirmDialog
        isOpen={showDeleteAllConfirm}
        title="Delete all conversations?"
        description={`This will permanently delete all ${allConversationCount} conversations and their associated messages, nodes, and context graph data. This action cannot be undone.`}
        confirmLabel="Delete everything"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          onDeleteAllData();
          setShowDeleteAllConfirm(false);
        }}
        onCancel={() => setShowDeleteAllConfirm(false)}
      />
    </>
  );
}

/* ─── Appearance Section ─────────────────────────────────────────────────── */

function AppearanceSection({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (m: ThemeMode) => void;
}) {
  const options: { value: ThemeMode; label: string; description: string }[] = [
    { value: "system", label: "System", description: "Follow your OS preference" },
    { value: "light", label: "Light", description: "Always use light mode" },
    { value: "dark", label: "Dark", description: "Always use dark mode" },
  ];

  return (
    <div>
      <p className="mb-4 text-[13px] text-[var(--muted-foreground)]">
        Choose how ContextGraph looks to you. Select a theme below.
      </p>
      <div className="space-y-2">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-all ${
              mode === opt.value
                ? "border-[var(--accent)] bg-[var(--accent-light)]"
                : "border-[var(--border)] hover:border-[var(--muted-foreground)]/30"
            }`}
          >
            <input
              type="radio"
              name="theme"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <div
              className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
                mode === opt.value
                  ? "border-[var(--accent)] bg-[var(--accent)]"
                  : "border-[var(--border)]"
              }`}
            >
              {mode === opt.value && (
                <div className="h-2 w-2 rounded-full bg-white" />
              )}
            </div>
            <div>
              <span className="block text-[14px] font-medium text-[var(--foreground)]">
                {opt.label}
              </span>
              <span className="block text-[12px] text-[var(--muted-foreground)]">
                {opt.description}
              </span>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ─── Archived Section ───────────────────────────────────────────────────── */

function ArchivedSection({
  conversations,
  onRestore,
  onDelete,
}: {
  conversations: ConversationListItem[];
  onRestore: (id: string) => void;
  onDelete: (conv: ConversationListItem) => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--muted)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--muted-foreground)]">
            <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-[13px] text-[var(--muted-foreground)]">
          No archived conversations
        </p>
        <p className="mt-1 text-[12px] text-[var(--muted-foreground)]/70">
          Archived conversations will appear here for recovery or deletion.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-[13px] text-[var(--muted-foreground)]">
        {conversations.length} archived conversation{conversations.length !== 1 ? "s" : ""}. Restore to make active again, or delete permanently.
      </p>
      <div className="space-y-1">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-[var(--foreground)]">
                {conv.title}
              </p>
              <p className="text-[11px] text-[var(--muted-foreground)]">
                {new Date(conv.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
            <div className="ml-3 flex items-center gap-1">
              <button
                onClick={() => onRestore(conv.id)}
                className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[var(--foreground)] transition hover:bg-[var(--muted)]"
              >
                Restore
              </button>
              <button
                onClick={() => onDelete(conv)}
                className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-red-600 transition hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Data & Privacy Section ─────────────────────────────────────────────── */

function DataSection({
  conversationCount,
  onDeleteAll,
}: {
  conversationCount: number;
  onDeleteAll: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Info */}
      <div>
        <h4 className="mb-1.5 text-[14px] font-medium text-[var(--foreground)]">
          Your data
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--muted-foreground)]">
          All your conversations, messages, and context graph data are stored in the database associated with this instance. Nothing is sent to third parties beyond the AI model provider.
        </p>
      </div>

      {/* Storage info */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)] px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-[var(--foreground)]">Total conversations</span>
          <span className="text-[13px] font-medium text-[var(--foreground)]">{conversationCount}</span>
        </div>
      </div>

      {/* Danger zone */}
      <div className="rounded-xl border border-red-200 bg-red-50/50 p-4">
        <h4 className="mb-1 text-[14px] font-medium text-red-700">
          Danger zone
        </h4>
        <p className="mb-3 text-[12px] leading-relaxed text-red-600/80">
          Permanently delete all conversations and their associated data. This includes all messages, context nodes, semantic edges, and graph data. This action is irreversible.
        </p>
        <button
          onClick={onDeleteAll}
          disabled={conversationCount === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.97]"
        >
          Delete all conversations
        </button>
      </div>
    </div>
  );
}
