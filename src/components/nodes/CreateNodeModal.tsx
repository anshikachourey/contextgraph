"use client";

import { useState, useEffect } from "react";
import type { ChatMessage } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import type {
  GenerateNodeSuggestionRequest,
  GenerateNodeSuggestionResponse,
  GenerateNodeSuggestionError,
} from "@/src/types/ai";

type CreateNodeModalProps = {
  selectedMessages: ChatMessage[];
  // Nodes that share some (but not all) messages with the current selection.
  // Non-empty means the user should be warned before creating.
  overlappingNodes?: ContextNode[];
  initialTitle?: string;
  initialSummary?: string;
  onConfirm: (title: string, summary: string) => void;
  onCancel: () => void;
};

export default function CreateNodeModal({
  selectedMessages,
  overlappingNodes = [],
  initialTitle = "",
  initialSummary = "",
  onConfirm,
  onCancel,
}: CreateNodeModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [summary, setSummary] = useState(initialSummary);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Sync if the parent updates initial values (e.g. future async prefill)
  useEffect(() => { setTitle(initialTitle); }, [initialTitle]);
  useEffect(() => { setSummary(initialSummary); }, [initialSummary]);

  // Escape key cancels
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const canConfirm = title.trim().length > 0;
  const canGenerate = selectedMessages.length > 0 && !isGenerating;

  async function handleGenerate() {
    if (!canGenerate) return;

    setIsGenerating(true);
    setGenerateError(null);

    const requestBody: GenerateNodeSuggestionRequest = {
      messages: selectedMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    try {
      const response = await fetch("/api/generate-node-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = (await response.json()) as
        | GenerateNodeSuggestionResponse
        | GenerateNodeSuggestionError;

      if (!response.ok) {
        const errorData = data as GenerateNodeSuggestionError;
        setGenerateError(errorData.error ?? "Generation failed. Please try again.");
        return;
      }

      const suggestion = data as GenerateNodeSuggestionResponse;
      // Populate the fields — user can edit before confirming
      setTitle(suggestion.title);
      setSummary(suggestion.summary);
    } catch {
      setGenerateError("Network error. Please check your connection and try again.");
    } finally {
      setIsGenerating(false);
    }
  }

  function handleConfirm() {
    if (!canConfirm) return;
    onConfirm(title.trim(), summary.trim());
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConfirm();
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onCancel();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 id="modal-title" className="text-base font-semibold">
            Create context node
          </h2>
          <button
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
            aria-label="Cancel and close modal"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {/* Overlap warning — shown when selected messages already belong to other nodes.
              This is NOT a blocker. Messages may legitimately belong to multiple nodes. */}
          {overlappingNodes.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-sm font-medium text-amber-800">
                Some selected messages already belong to{" "}
                {overlappingNodes.length === 1
                  ? "another node"
                  : `${overlappingNodes.length} other nodes`}
                :
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {overlappingNodes.map((n) => (
                  <li key={n.id} className="text-sm text-amber-700">
                    · {n.title}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-amber-600">
                You can still create this node. Shared messages will be linked
                to both topics.
              </p>
            </div>
          )}

          {/* AI generation */}
          <div>
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isGenerating ? (
                <>
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                  Generating…
                </>
              ) : (
                <>✦ Generate suggestion</>
              )}
            </button>

            {generateError && (
              <p className="mt-2 text-xs text-red-600" role="alert">
                {generateError}
              </p>
            )}
          </div>

          {/* Title */}
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
              onKeyDown={handleTitleKeyDown}
              placeholder="e.g. Core Problem, Business Strategy…"
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black focus:ring-1 focus:ring-black"
              autoFocus
            />
          </div>

          {/* Summary */}
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

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-200 px-6 py-4">
          <button
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            Create node
          </button>
        </div>
      </div>
    </div>
  );
}
