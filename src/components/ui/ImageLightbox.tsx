"use client";

import { useEffect, useRef, useCallback } from "react";

type ImageLightboxProps = {
  images: Array<{ url: string; filename: string }>;
  initialIndex: number;
  onClose: () => void;
};

/**
 * Full-screen image lightbox with:
 * - Darkened backdrop
 * - Fit-to-viewport display preserving aspect ratio
 * - Previous/next controls for multiple images
 * - Close via X, Escape, or clicking backdrop
 * - Focus trapping and keyboard accessibility
 */
export default function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const currentIndex = useRef(initialIndex);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Force re-render when index changes
  const setIndex = useCallback((idx: number) => {
    currentIndex.current = idx;
    if (imgRef.current) {
      imgRef.current.src = images[idx].url;
      imgRef.current.alt = images[idx].filename;
    }
    // Update counter text
    const counter = document.getElementById("lightbox-counter");
    if (counter) {
      counter.textContent = `${idx + 1} / ${images.length}`;
    }
  }, [images]);

  const goNext = useCallback(() => {
    if (images.length <= 1) return;
    const next = (currentIndex.current + 1) % images.length;
    setIndex(next);
  }, [images.length, setIndex]);

  const goPrev = useCallback(() => {
    if (images.length <= 1) return;
    const prev = (currentIndex.current - 1 + images.length) % images.length;
    setIndex(prev);
  }, [images.length, setIndex]);

  // Keyboard handling
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowRight":
          goNext();
          break;
        case "ArrowLeft":
          goPrev();
          break;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, goNext, goPrev]);

  // Focus trap — focus the container on mount
  useEffect(() => {
    containerRef.current?.focus();
    // Prevent body scroll while lightbox is open
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const image = images[initialIndex];

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${image.filename}`}
      className="fixed inset-0 z-[200] flex items-center justify-center outline-none"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />

      {/* Content — stop propagation so clicking image doesn't close */}
      <div
        className="relative z-10 flex max-h-[90vh] max-w-[90vw] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top bar: filename + close */}
        <div className="mb-3 flex w-full items-center justify-between px-1">
          <span className="truncate text-[13px] text-white/70 max-w-[60%]">
            {image.filename}
          </span>
          <div className="flex items-center gap-3">
            {images.length > 1 && (
              <span
                id="lightbox-counter"
                className="text-[13px] text-white/60"
              >
                {initialIndex + 1} / {images.length}
              </span>
            )}
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/20"
              aria-label="Close image viewer"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Image */}
        <img
          ref={imgRef}
          src={image.url}
          alt={image.filename}
          className="max-h-[80vh] max-w-[88vw] rounded-lg object-contain shadow-2xl"
          draggable={false}
        />

        {/* Previous / Next controls */}
        {images.length > 1 && (
          <>
            <button
              onClick={goPrev}
              className="absolute left-[-48px] top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
              aria-label="Previous image"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <button
              onClick={goNext}
              className="absolute right-[-48px] top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
              aria-label="Next image"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
