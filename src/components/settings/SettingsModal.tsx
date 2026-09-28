"use client";

import { useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
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

  const sections: { id: SettingsSection; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "archived", label: "Archived" },
    { id: "data", label: "Data & Privacy" },
  ];

  const activeLabel = sections.find((s) => s.id === activeSection)?.label;

  return (
    <>
      <Dialog
        isOpen={isOpen}
        onOpenChange={(open) => { if (!open) onClose(); }}
        purpose="info"
        width={640}
        aria-label="Settings"
      >
        <Layout
          header={<DialogHeader title={activeLabel ?? "Settings"} onOpenChange={(open) => { if (!open) onClose(); }} />}
          content={
            <LayoutContent>
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
            </LayoutContent>
          }
          end={
            <LayoutPanel>
              <nav className="flex w-44 shrink-0 flex-col gap-0.5 py-2">
                <h2 className="mb-2 px-2 text-[13px] font-semibold text-[var(--foreground)]">
                  Settings
                </h2>
                {sections.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    aria-current={activeSection === section.id ? "page" : undefined}
                    className={`flex items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
                      activeSection === section.id
                        ? "bg-[var(--muted)] text-[var(--foreground)] font-medium"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)]/60"
                    }`}
                  >
                    {section.label}
                  </button>
                ))}
              </nav>
            </LayoutPanel>
          }
        />
      </Dialog>

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
      <RadioList
        label="Theme"
        isLabelHidden
        value={mode}
        onChange={(v) => onChange(v as ThemeMode)}
      >
        {options.map((opt) => (
          <RadioListItem
            key={opt.value}
            value={opt.value}
            label={opt.label}
            description={opt.description}
          />
        ))}
      </RadioList>
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
              <Button label="Restore" variant="ghost" size="sm" onClick={() => onRestore(conv.id)} />
              <Button label="Delete" variant="ghost" size="sm" onClick={() => onDelete(conv)} />
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
      <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 dark:border-red-900/40 dark:bg-red-950/20">
        <h4 className="mb-1 text-[14px] font-medium text-red-700 dark:text-red-400">
          Danger zone
        </h4>
        <p className="mb-3 text-[12px] leading-relaxed text-red-600/80 dark:text-red-400/70">
          Permanently delete all conversations and their associated data. This includes all messages, context nodes, semantic edges, and graph data. This action is irreversible.
        </p>
        <Button
          label="Delete all conversations"
          variant="destructive"
          isDisabled={conversationCount === 0}
          onClick={onDeleteAll}
        />
      </div>
    </div>
  );
}
