import type { ConversationListItem } from "@/src/lib/db/conversations";

type ConversationSidebarProps = {
  conversations: ConversationListItem[];
  activeConversationId: string | null;
  isCreating: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
};

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  isCreating,
  onSelect,
  onNewChat,
}: ConversationSidebarProps) {
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

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {conversations.length === 0 && (
          <p className="px-3 py-4 text-xs text-gray-400">No conversations yet</p>
        )}

        {conversations.map((conv) => {
          const isActive = conv.id === activeConversationId;
          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                isActive
                  ? "bg-gray-200 font-medium text-black"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              <span className="block truncate">{conv.title}</span>
              {conv.updatedAt && (
                <span className="block truncate text-xs text-gray-400">
                  {formatRelativeTime(conv.updatedAt || conv.createdAt)}
                </span>
              )}
            </button>
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
