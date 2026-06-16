import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";

type NodeDetailPanelProps = {
  node: ContextNode;
  linkedMessages: ChatMessage[];
  onClose: () => void;
};

export default function NodeDetailPanel({
  node,
  linkedMessages,
  onClose,
}: NodeDetailPanelProps) {
  return (
    <div className="flex h-full flex-col border-t border-gray-200 bg-white">
      {/* Panel header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Node
          </p>
          <h3 className="mt-0.5 text-base font-semibold leading-snug">
            {node.title}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="ml-4 mt-0.5 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
          aria-label="Close node detail"
        >
          ✕
        </button>
      </div>

      {/* Summary */}
      <p className="px-5 text-sm text-gray-600">{node.summary}</p>

      {/* Linked messages */}
      <div className="mt-4 flex-1 overflow-y-auto px-5 pb-5">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          {linkedMessages.length} linked message
          {linkedMessages.length === 1 ? "" : "s"}
        </p>

        <div className="space-y-2">
          {linkedMessages.map((message) => (
            <div
              key={message.id}
              className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
            >
              <p className="mb-1 text-xs font-semibold text-gray-400">
                {message.role === "user" ? "You" : "Assistant"}
              </p>
              <p className="line-clamp-3 text-sm text-gray-700">
                {message.content}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
