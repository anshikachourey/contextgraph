"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Banner } from "@astryxdesign/core/Banner";
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

  return (
    <Dialog
      isOpen
      // Escape and backdrop click both request close, matching the previous
      // behavior (Escape cancelled; clicking the backdrop cancelled).
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      purpose="info"
      width={512}
      aria-label="Create context node"
    >
      <Layout
        header={
          <DialogHeader title="Create context node" onOpenChange={(open) => { if (!open) onCancel(); }} />
        }
        content={
          <LayoutContent>
            <div className="space-y-5">
              {/* Overlap warning — shown when selected messages already belong to other nodes.
                  This is NOT a blocker. Messages may legitimately belong to multiple nodes. */}
              {overlappingNodes.length > 0 && (
                <Banner
                  status="warning"
                  collapsible={false}
                  title={
                    <>
                      Some selected messages already belong to{" "}
                      {overlappingNodes.length === 1
                        ? "another node"
                        : `${overlappingNodes.length} other nodes`}
                    </>
                  }
                >
                  <ul className="space-y-0.5">
                    {overlappingNodes.map((n) => (
                      <li key={n.id} className="text-[13px]">· {n.title}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12px]">
                    You can still create this node. Shared messages will be linked
                    to both topics.
                  </p>
                </Banner>
              )}

              {/* AI generation */}
              <div>
                <Button
                  label="✦ Generate suggestion"
                  variant="secondary"
                  isLoading={isGenerating}
                  isDisabled={!canGenerate}
                  onClick={handleGenerate}
                />
                {generateError && (
                  <p className="mt-2 text-[12px] text-red-600" role="alert">
                    {generateError}
                  </p>
                )}
              </div>

              {/* Title */}
              <TextInput
                label="Title"
                value={title}
                onChange={setTitle}
                onEnter={handleConfirm}
                placeholder="e.g. Core Problem, Business Strategy…"
                hasAutoFocus
              />

              {/* Summary */}
              <TextArea
                label="Summary"
                isOptional
                value={summary}
                onChange={setSummary}
                placeholder="Briefly describe what this node represents…"
                rows={3}
              />

              {/* Selected message previews */}
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  {selectedMessages.length} selected message
                  {selectedMessages.length === 1 ? "" : "s"}
                </p>
                <div className="max-h-40 space-y-2 overflow-y-auto">
                  {selectedMessages.map((message) => (
                    <div
                      key={message.id}
                      className="rounded-xl border border-[var(--border)] bg-[var(--muted)] px-3 py-2"
                    >
                      <p className="mb-0.5 text-[11px] font-semibold text-[var(--muted-foreground)]">
                        {message.role === "user" ? "You" : "Assistant"}
                      </p>
                      <p className="line-clamp-2 text-[13px] text-[var(--foreground)]">
                        {message.content}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <Button label="Cancel" variant="ghost" onClick={onCancel} />
            <Button
              label="Create node"
              variant="primary"
              isDisabled={!canConfirm}
              onClick={handleConfirm}
            />
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
