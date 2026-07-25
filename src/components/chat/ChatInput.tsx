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
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow height on value change
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const scrollHeight = textarea.scrollHeight;
    if (scrollHeight > 200) {
      textarea.style.height = "200px";
      textarea.style.overflowY = "auto";
    } else {
      textarea.style.height = `${scrollHeight}px`;
      textarea.style.overflowY = "hidden";
    }
  }, [value]);

  // Focus the textarea when component mounts
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

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

    const totalAfterAdd = pendingFiles.length + newFiles.length;
    if (totalAfterAdd > MAX_ATTACHMENTS) {
      setAttachmentError(
        `Maximum ${MAX_ATTACHMENTS} attachments allowed. You have ${pendingFiles.length}, tried to add ${newFiles.length}.`
      );
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

    e.target.value = "";
  }

  function handleRemoveFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachmentError(null);
  }

  async function handleSend() {
    const trimmed = value.trim();
    if ((!trimmed && pendingFiles.length === 0) || disabled || isUploading) return;

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

        onSendMessage(trimmed, uploadedMetas);
        setValue("");
        setPendingFiles([]);
        setAttachmentError(null);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Upload failed. Please try again.";
        setAttachmentError(errorMsg);
        return;
      } finally {
        setIsUploading(false);
      }
    } else {
      if (!trimmed) return;
      onSendMessage(trimmed);
      setValue("");
    }

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
  }

  function isImageFile(file: File): boolean {
    return file.type.startsWith("image/");
  }

  const hasContent = value.trim().length > 0 || pendingFiles.length > 0;
  const isDisabled = disabled || isUploading || !hasContent;

  return (
    <div
      className={`rounded-2xl border bg-[var(--surface)] p-3 shadow-lg shadow-black/[0.04] transition-all ${
        isFocused
          ? "border-[var(--accent)]/40 shadow-[var(--accent)]/5 ring-1 ring-[var(--accent)]/10"
          : "border-[var(--border)]"
      }`}
    >
      {/* Attachment previews */}
      {pendingFiles.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-2">
          {pendingFiles.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="relative flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] p-1.5"
            >
              {isImageFile(file) ? (
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="rounded-md object-cover"
                  style={{ maxWidth: "72px", maxHeight: "72px" }}
                />
              ) : (
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--muted-foreground)]">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" strokeLinecap="round" strokeLinejoin="round" />
                    <polyline points="14 2 14 8 20 8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="max-w-[100px] truncate text-[12px] text-[var(--foreground)]/70">
                    {file.name}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => handleRemoveFile(index)}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white shadow-sm hover:bg-red-600 transition-colors"
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
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          {attachmentError}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-1">
        {/* Attachment button */}
        <button
          type="button"
          onClick={handleAttachmentClick}
          disabled={disabled || isUploading}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Attach file"
          title="Attach file"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
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

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          disabled={disabled || isUploading}
          rows={1}
          className="flex-1 resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-[var(--muted-foreground)]/50 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={
            disabled
              ? "Thinking…"
              : isUploading
                ? "Uploading…"
                : "Message ContextGraph…"
          }
          style={{ maxHeight: "200px" }}
        />

        {/* Send / Stop button */}
        <button
          onClick={handleSend}
          disabled={isDisabled}
          className={`ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all ${
            hasContent && !disabled
              ? "bg-[var(--foreground)] text-[var(--background)] hover:opacity-80 active:scale-95"
              : "bg-[var(--muted)] text-[var(--muted-foreground)] cursor-not-allowed opacity-50"
          }`}
          aria-label={disabled ? "Stop generating" : "Send message"}
        >
          {isUploading ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
              <path d="M21 12a9 9 0 11-6.219-8.56" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          )}
        </button>
      </div>

      {/* Footer hint */}
      {isFocused && !disabled && (
        <div className="mt-2 flex items-center justify-between px-1">
          <span className="text-[11px] text-[var(--muted-foreground)]/60">
            <kbd className="rounded border border-[var(--border)] px-1 py-0.5 text-[10px]">Enter</kbd> to send · <kbd className="rounded border border-[var(--border)] px-1 py-0.5 text-[10px]">Shift+Enter</kbd> for new line
          </span>
          {value.length > 200 && (
            <span className="text-[11px] text-[var(--muted-foreground)]/60">
              {value.length.toLocaleString()} chars
            </span>
          )}
        </div>
      )}
    </div>
  );
}
