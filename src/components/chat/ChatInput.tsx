"use client";

import { useState, useRef, useEffect } from "react";
import type { AttachmentMeta } from "@/src/types/message";
import {
  validateFile,
  uploadAttachment,
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENTS,
} from "@/src/lib/attachments";

type ChatInputProps = {
  onSendMessage: (content: string, attachments?: AttachmentMeta[]) => void;
  disabled?: boolean;
  conversationId?: string | null;
};

export default function ChatInput({
  onSendMessage,
  disabled = false,
  conversationId,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow height on value change
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto so scrollHeight recalculates from content
    textarea.style.height = "auto";

    // Clamp to max 200px
    const scrollHeight = textarea.scrollHeight;
    if (scrollHeight > 200) {
      textarea.style.height = "200px";
      textarea.style.overflowY = "auto";
    } else {
      textarea.style.height = `${scrollHeight}px`;
      textarea.style.overflowY = "hidden";
    }
  }, [value]);

  function handleAttachmentClick() {
    fileInputRef.current?.click();
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setAttachmentError(null);
    const newFiles = Array.from(files);
    const validFiles: File[] = [];
    const errors: string[] = [];

    // Check total count limit
    const totalAfterAdd = pendingFiles.length + newFiles.length;
    if (totalAfterAdd > MAX_ATTACHMENTS) {
      setAttachmentError(
        `Maximum ${MAX_ATTACHMENTS} attachments allowed. You have ${pendingFiles.length}, tried to add ${newFiles.length}.`
      );
      // Reset input so user can re-select
      e.target.value = "";
      return;
    }

    for (const file of newFiles) {
      const result = validateFile(file);
      if (result.valid) {
        validFiles.push(file);
      } else {
        errors.push(result.error!);
      }
    }

    if (errors.length > 0) {
      setAttachmentError(errors.join(" "));
    }

    if (validFiles.length > 0) {
      setPendingFiles((prev) => [...prev, ...validFiles]);
    }

    // Reset input value so the same file can be re-selected
    e.target.value = "";
  }

  function handleRemoveFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachmentError(null);
  }

  async function handleSend() {
    const trimmed = value.trim();
    if ((!trimmed && pendingFiles.length === 0) || disabled || isUploading) return;

    // If there are pending files, upload them first
    if (pendingFiles.length > 0) {
      if (!conversationId) {
        setAttachmentError("Cannot upload attachments: no active conversation.");
        return;
      }

      setIsUploading(true);
      setAttachmentError(null);

      try {
        const uploadedMetas: AttachmentMeta[] = [];
        for (const file of pendingFiles) {
          const meta = await uploadAttachment(file, conversationId);
          uploadedMetas.push(meta);
        }

        // All uploads succeeded — send message with attachments
        onSendMessage(trimmed, uploadedMetas);
        setValue("");
        setPendingFiles([]);
        setAttachmentError(null);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Upload failed. Please try again.";
        setAttachmentError(errorMsg);
        // Retain composer state — don't clear or send
        return;
      } finally {
        setIsUploading(false);
      }
    } else {
      // No attachments, just send text
      if (!trimmed) return;
      onSendMessage(trimmed);
      setValue("");
    }

    // Reset height after clearing
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.overflowY = "hidden";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Shift+Enter: default behavior inserts newline
  }

  function isImageFile(file: File): boolean {
    return file.type.startsWith("image/");
  }

  const isDisabled =
    disabled || isUploading || (!value.trim() && pendingFiles.length === 0);

  return (
    <div className="rounded-2xl border border-gray-300 bg-white p-3 shadow-sm">
      {/* Attachment previews */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="relative flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1"
            >
              {isImageFile(file) ? (
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="rounded object-cover"
                  style={{ maxWidth: "80px", maxHeight: "80px" }}
                />
              ) : (
                <span className="max-w-[120px] truncate px-2 py-1 text-xs text-gray-700">
                  {file.name}
                </span>
              )}
              <button
                type="button"
                onClick={() => handleRemoveFile(index)}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white hover:bg-red-600"
                aria-label={`Remove ${file.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Error message */}
      {attachmentError && (
        <div className="mb-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-600">
          {attachmentError}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end">
        {/* Attachment button */}
        <button
          type="button"
          onClick={handleAttachmentClick}
          disabled={disabled || isUploading}
          className="mr-2 flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Attach file"
          title="Attach file"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALLOWED_MIME_TYPES.join(",")}
          onChange={handleFileSelect}
          className="hidden"
          aria-hidden="true"
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isUploading}
          rows={1}
          className="flex-1 resize-none outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={
            disabled
              ? "Assistant is responding…"
              : isUploading
                ? "Uploading attachments…"
                : "Ask ContextGraph..."
          }
          style={{ maxHeight: "200px" }}
        />

        <button
          onClick={handleSend}
          disabled={isDisabled}
          className="ml-2 rounded-xl bg-black px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {isUploading ? "Uploading…" : "Send"}
        </button>
      </div>
    </div>
  );
}
