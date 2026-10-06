"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * useSmoothStream — decouples a bursty token stream from the render cadence.
 *
 * Network streams deliver text in uneven chunks: a few characters, then a long
 * pause, then a big burst. Appending each chunk straight to React state makes
 * the message jump forward in abrupt, uneven steps.
 *
 * This hook buffers incoming text and releases it to `onFlush` at a steady,
 * capped rate per animation frame, producing a smooth "typewriter" reveal that
 * looks consistent regardless of how the bytes actually arrive.
 *
 * Accessibility: when the user prefers reduced motion, buffering is bypassed and
 * text is flushed immediately so nothing is animated.
 *
 * Usage:
 *   const { push, flushNow, reset } = useSmoothStream((chunk) => {
 *     setMessage((m) => m + chunk);
 *   });
 *   // on each network token: push(token)
 *   // on stream complete:    flushNow()   // release any remaining buffer at once
 *   // before a new stream:   reset()
 */
export type SmoothStreamControls = {
  /** Queue newly received text to be revealed smoothly. */
  push: (text: string) => void;
  /** Immediately release everything still buffered (e.g. on stream complete). */
  flushNow: () => void;
  /** Drop any buffered text and stop the animation loop. */
  reset: () => void;
};

export type SmoothStreamOptions = {
  /**
   * Minimum characters released per frame. The loop also scales with the
   * backlog so large bursts don't fall behind. Default 2.
   */
  minCharsPerFrame?: number;
  /**
   * Fraction of the pending backlog released each frame (on top of the
   * minimum), so the reveal speeds up when a lot is waiting. Default 0.08.
   */
  catchUpFactor?: number;
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useSmoothStream(
  onFlush: (chunk: string) => void,
  options: SmoothStreamOptions = {},
): SmoothStreamControls {
  const { minCharsPerFrame = 2, catchUpFactor = 0.08 } = options;

  // Keep the latest onFlush without restarting the loop on every render.
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  const bufferRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef<boolean>(false);

  useEffect(() => {
    reducedMotionRef.current = prefersReducedMotion();
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const pending = bufferRef.current.length;
    if (pending === 0) {
      rafRef.current = null;
      return;
    }

    // Release a steady baseline plus a slice proportional to the backlog, so the
    // reveal keeps pace with large bursts without ever lurching all at once.
    const take = Math.max(
      minCharsPerFrame,
      Math.ceil(pending * catchUpFactor),
    );

    const chunk = bufferRef.current.slice(0, take);
    bufferRef.current = bufferRef.current.slice(take);
    onFlushRef.current(chunk);

    rafRef.current = requestAnimationFrame(tick);
  }, [minCharsPerFrame, catchUpFactor]);

  const push = useCallback(
    (text: string) => {
      if (!text) return;

      // Reduced motion: no smoothing, surface text immediately.
      if (reducedMotionRef.current) {
        onFlushRef.current(text);
        return;
      }

      bufferRef.current += text;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    },
    [tick],
  );

  const flushNow = useCallback(() => {
    stopLoop();
    if (bufferRef.current) {
      const remaining = bufferRef.current;
      bufferRef.current = "";
      onFlushRef.current(remaining);
    }
  }, [stopLoop]);

  const reset = useCallback(() => {
    stopLoop();
    bufferRef.current = "";
  }, [stopLoop]);

  // Clean up the animation frame if the component unmounts mid-stream.
  useEffect(() => stopLoop, [stopLoop]);

  return { push, flushNow, reset };
}
