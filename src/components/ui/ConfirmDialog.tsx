"use client";

import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
      // Focus the cancel button (safer default) after a tick
      setTimeout(() => confirmButtonRef.current?.focus(), 0);
    } else {
      dialog.close();
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        onCancel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const isDanger = variant === "danger";

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-[100] m-auto w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 shadow-2xl shadow-black/10 backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      onClose={onCancel}
    >
      <div className="p-6">
        {/* Icon */}
        <div className={`mb-4 flex h-11 w-11 items-center justify-center rounded-full ${
          isDanger ? "bg-red-50" : "bg-[var(--accent-light)]"
        }`}>
          {isDanger ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          )}
        </div>

        {/* Title */}
        <h3 className="mb-1.5 text-[16px] font-semibold text-[var(--foreground)]">
          {title}
        </h3>

        {/* Description */}
        <p className="text-[13px] leading-relaxed text-[var(--muted-foreground)]">
          {description}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
        <button
          onClick={onCancel}
          className="rounded-lg border border-[var(--border)] px-4 py-2 text-[13px] font-medium text-[var(--foreground)] transition hover:bg-[var(--muted)]"
        >
          {cancelLabel}
        </button>
        <button
          ref={confirmButtonRef}
          onClick={onConfirm}
          className={`rounded-lg px-4 py-2 text-[13px] font-medium text-white transition active:scale-[0.97] ${
            isDanger
              ? "bg-red-600 hover:bg-red-700"
              : "bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
