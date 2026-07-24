"use client";

import { useState, useRef, useCallback } from "react";

/**
 * Options for configuring stream behavior callbacks.
 */
export type StreamChatCallbacks = {
  onToken: (content: string) => void;
  onComplete: (fullContent: string, stopReason: string) => void;
  onError: (error: string, partialContent: string) => void;
};

/**
 * Options passed to sendMessage for the API request.
 */
export type SendMessageOptions = {
  maxTokens?: number;
  branchContext?: {
    nodeTitle: string;
    nodeSummary: string;
    evidenceSummary?: string;
    linkedMessages?: Array<{ role: string; content: string }>;
  };
  conversationId?: string;
  attachments?: Array<{ url: string; filename: string; mimeType: string; size: number }>;
};

/** Individual parsed line from the stream */
type StreamLine =
  | { type: "token"; content: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: string };

const STREAM_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Hook for streaming chat responses from /api/chat.
 *
 * Reads the response body as a ReadableStream, parses newline-delimited JSON chunks,
 * and provides progressive updates via callbacks.
 *
 * - On each `token` chunk: calls onToken with the token content
 * - On `done` chunk: marks streaming complete, calls onComplete
 * - On `error` chunk or network failure: calls onError with partial content
 * - 30-second timeout: if no token arrives for 30s, treats as timeout error
 */
export function useStreamChat(callbacks: StreamChatCallbacks) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Refs to hold mutable state during streaming
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedContentRef = useRef<string>("");
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  /** Clear the inactivity timeout */
  const clearStreamTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  /** Reset the inactivity timeout — fires if no token arrives for 30s */
  const resetStreamTimeout = useCallback(() => {
    clearStreamTimeout();
    timeoutRef.current = setTimeout(() => {
      // Timeout fired — abort the fetch and report error
      abortControllerRef.current?.abort();
      const partial = accumulatedContentRef.current;
      setIsStreaming(false);
      setStreamError("Response timed out — no data received for 30 seconds.");
      callbacksRef.current.onError(
        "Response timed out — no data received for 30 seconds.",
        partial,
      );
    }, STREAM_TIMEOUT_MS);
  }, [clearStreamTimeout]);

  /**
   * Send a message array to /api/chat and stream the response.
   */
  const sendMessage = useCallback(
    async (
      messages: Array<{ role: string; content: string }>,
      options?: SendMessageOptions,
    ) => {
      // Prevent concurrent streams
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Reset state
      setIsStreaming(true);
      setStreamError(null);
      accumulatedContentRef.current = "";

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build request body
      const body: Record<string, unknown> = { messages };
      if (options?.maxTokens !== undefined) body.maxTokens = options.maxTokens;
      if (options?.branchContext !== undefined) body.branchContext = options.branchContext;
      if (options?.conversationId !== undefined) body.conversationId = options.conversationId;
      if (options?.attachments !== undefined) body.attachments = options.attachments;

      try {
        // Start the timeout timer
        resetStreamTimeout();

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // Handle non-OK responses (validation errors, server errors)
        if (!response.ok) {
          clearStreamTimeout();
          let errorMessage = `Request failed with status ${response.status}`;
          try {
            const errorData = await response.json();
            if (errorData.error) errorMessage = errorData.error;
          } catch {
            // Use default error message
          }
          setIsStreaming(false);
          setStreamError(errorMessage);
          callbacksRef.current.onError(errorMessage, "");
          return;
        }

        // Read the stream
        const reader = response.body?.getReader();
        if (!reader) {
          clearStreamTimeout();
          const err = "Response body is not readable.";
          setIsStreaming(false);
          setStreamError(err);
          callbacksRef.current.onError(err, "");
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Stream ended without explicit "done" chunk — treat accumulated as final
            clearStreamTimeout();
            if (accumulatedContentRef.current) {
              setIsStreaming(false);
              callbacksRef.current.onComplete(accumulatedContentRef.current, "end_turn");
            } else {
              setIsStreaming(false);
            }
            break;
          }

          // Decode the chunk and append to buffer
          buffer += decoder.decode(value, { stream: true });

          // Parse complete lines from buffer
          const lines = buffer.split("\n");
          // Keep the last incomplete line in buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let parsed: StreamLine;
            try {
              parsed = JSON.parse(trimmed) as StreamLine;
            } catch {
              // Skip malformed lines
              continue;
            }

            switch (parsed.type) {
              case "token": {
                // Reset timeout on each token received
                resetStreamTimeout();
                accumulatedContentRef.current += parsed.content;
                callbacksRef.current.onToken(parsed.content);
                break;
              }

              case "done": {
                clearStreamTimeout();
                setIsStreaming(false);
                callbacksRef.current.onComplete(
                  accumulatedContentRef.current,
                  parsed.stopReason,
                );
                // Cancel the reader since we're done
                reader.cancel().catch(() => {});
                return;
              }

              case "error": {
                clearStreamTimeout();
                const partial = accumulatedContentRef.current;
                setIsStreaming(false);
                setStreamError(parsed.error);
                callbacksRef.current.onError(parsed.error, partial);
                reader.cancel().catch(() => {});
                return;
              }
            }
          }
        }
      } catch (err: unknown) {
        clearStreamTimeout();
        const partial = accumulatedContentRef.current;

        // Don't report abort errors caused by our own timeout handler
        if (err instanceof DOMException && err.name === "AbortError") {
          // Already handled by the timeout callback if it was a timeout.
          // If it was a manual abort (new sendMessage call), just clean up.
          if (!streamError) {
            setIsStreaming(false);
          }
          return;
        }

        const errorMessage =
          err instanceof Error ? err.message : "Network error during streaming.";
        setIsStreaming(false);
        setStreamError(errorMessage);
        callbacksRef.current.onError(errorMessage, partial);
      } finally {
        abortControllerRef.current = null;
      }
    },
    [resetStreamTimeout, clearStreamTimeout, streamError],
  );

  return { sendMessage, isStreaming, streamError };
}
