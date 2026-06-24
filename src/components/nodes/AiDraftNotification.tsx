"use client";

type AiDraftNotificationProps = {
  onReview: () => void;
  onDismiss: () => void;
};

/**
 * Small non-blocking notification pill shown when the AI has prepared a node draft.
 * Positioned above the chat input area.
 */
export default function AiDraftNotification({
  onReview,
  onDismiss,
}: AiDraftNotificationProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-purple-200 bg-purple-50 px-4 py-2.5 shadow-sm">
      <span className="text-sm text-purple-800">
        ✨ AI prepared a node
      </span>
      <div className="ml-auto flex gap-2">
        <button
          onClick={onReview}
          className="rounded-lg bg-purple-700 px-3 py-1 text-xs font-medium text-white transition hover:bg-purple-800"
        >
          Review
        </button>
        <button
          onClick={onDismiss}
          className="rounded-lg px-3 py-1 text-xs font-medium text-purple-600 transition hover:bg-purple-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
