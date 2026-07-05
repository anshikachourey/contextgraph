"use client";

import { useState } from "react";
import type { ConversationListItem } from "@/src/lib/db/conversations";

type ConversationSidebarProps = {
  conversations: ConversationListItem[];
  activeConversationId: string | null;
  isCreating: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
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
  archivedConversations,
}: ConversationSidebarProps) {
  const [showArchived, setShowArchived] = useState(false);

  const displayList = showArchived ? archivedConversations : conversations;

  return (
    <aside className="fixed left-0 top-16 bottom-0 z-10 flex w-64 flex-col border-r border-gray-200 bg-gray-50">
      {/* New chat button */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          disabled={isCreating}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCreating ? "Creating..." : "+ New chat"}
        </button>
      </div>

      {/* Active / Archived toggle */}
      <div className="flex border-b border-gray-200 px-3 pb-2">
        <button
          onClick={() => setShowArchived(false)}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            !showArchived ? "bg-gray-200 text-black" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Active ({conversations.length})
        </button>
        <button
          onClick={() => setShowArchived(true)}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            showArchived ? "bg-gray-200 text-black" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Archived ({archivedConversations.length})
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {displayList.length === 0 && (
          <p className="px-3 py-4 text-xs text-gray-400">
            {showArchived ? "No archived conversations" : "No conversations yet"}
          </p>
        )}

        {displayList.map((conv) => {
          const isActive = conv.id === activeConversationId;
          return (
            <div
              key={conv.id}
              className={`group mb-1 flex items-center rounded-md pr-1 transition-colors ${
                isActive ? "bg-gray-200" : "hover:bg-gray-100"
              }`}
            >
              <button
                onClick={() => !showArchived && onSelect(conv.id)}
                className={`flex-1 min-w-0 px-3 py-2 text-left text-sm ${
                  isActive ? "font-medium text-black" : "text-gray-600"
                }`}
              >
                <span className="block truncate">{conv.title}</span>
                <span className="block truncate text-xs text-gray-400">
                  {formatRelativeTime(conv.updatedAt || conv.createdAt)}
                </span>
              </button>

              {/* Archive / Restore action */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  showArchived ? onRestore(conv.id) : onArchive(conv.id);
                }}
                className="hidden shrink-0 rounded p-1 text-gray-400 hover:bg-gray-300 hover:text-gray-600 group-hover:block"
                title={showArchived ? "Restore" : "Archive"}
              >
                {showArchived ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                )}
              </button>
            </div>
          );
        })}
      </div>
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
