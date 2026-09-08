"use client";

import { AlertDialog } from "@astryxdesign/core/AlertDialog";

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

/**
 * Confirmation dialog.
 *
 * Backed by Astryx's AlertDialog, which implements the WAI-ARIA alertdialog
 * pattern: role="alertdialog", focus moved into the dialog on open and returned
 * to the trigger on close, Escape cancels, and backdrop clicks do NOT dismiss
 * (destructive-safe). The public API and behavior are unchanged from the
 * previous implementation.
 */
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
  return (
    <AlertDialog
      isOpen={isOpen}
      // AlertDialog reports visibility changes (Escape / cancel button) here.
      // Any close that is not the confirming action is treated as a cancel,
      // matching the previous onCancel semantics.
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={title}
      description={description}
      actionLabel={confirmLabel}
      cancelLabel={cancelLabel}
      actionVariant={variant === "danger" ? "destructive" : "primary"}
      onAction={onConfirm}
    />
  );
}
