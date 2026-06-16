"use client";

import { useState } from "react";
import type { ChatMessage } from "@/src/types/message";

type CreateNodeModalProps = {
  selectedMessages: ChatMessage[];
  onConfirm: (title: string, summary: string) => void;
  onCancel: () => void;
};

export default function CreateNodeModal({
  selectedMessages,
  onConfirm,
  onCancel,
}: CreateNodeModalProps) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");

  function handleConfirm() {
    const trimmedTitle = title.trim();
    const trimmedSummary = summary.trim();
    if (!trimmedTitle) return; // title is required
    onConfirm(trimmedTitle, trimmedSummary);
  }

  // Close on backdrop click
  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-base font-semibold">Create context node</h2>
          <button
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Title input */}
          <div>
            <label
              htmlFor="node-title"
              className="mb-1.5 block text-sm font-medium text-gray-700"
            >
              Title
            </label>
            <input
              id="node-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Core Problem, Business Strategy…"
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black focus:ring-1 focus:ring-black"
              autoFocus
            />
          </div>

          {/* Summary textarea */}
          <div>
            <label
              htmlFor="node-summary"
              className="mb-1.5 block text-sm font-medium text-gray-700"
            >
              Summary
              <span className="ml-1 font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id="node-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Briefly describe what this node represents…"
              rows={3}
              className="w-full resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black focus:ring-1 focus:ring-black"
            />
          </div>

          {/* Selected message previews */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
              {selectedMessages.length} selected message
              {selectedMessages.length === 1 ? "" : "s"}
            </p>
            <div className="max-h-40 space-y-2 overflow-y-auto">
              {selectedMessages.map((message) => (
                <div
                  key={message.id}
                  className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
                >
                  <p className="mb-0.5 text-xs font-semibold text-gray-400">
                    {message.role === "user" ? "You" : "Assistant"}
                  </p>
                  <p className="line-clamp-2 text-sm text-gray-700">
                    {message.content}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div className="flex justify-end gap-2 border-t border-gray-200 px-6 py-4">
          <button
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!title.trim()}
            className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            Create node
          </button>
        </div>
      </div>
    </div>
  );
}
