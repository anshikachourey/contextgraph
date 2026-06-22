"use client";

import { useState } from "react";
import type { ChatMessage } from "@/src/types/message";

// Mirror the API response shape
type TopicShiftResult = {
  boundaryIndex: number;
  similarity: number;
  confidence: "high" | "moderate" | "none";
  referenceWindow: ChatMessage[];
  currentWindow: ChatMessage[];
};

type TopicShiftAnalysis = {
  shifts: TopicShiftResult[];
  detectedShifts: TopicShiftResult[];
  config: {
    windowSize: number;
    shiftThreshold: number;
    highConfidenceShift: number;
  };
  messageCount: number;
};

function confidenceBadge(confidence: TopicShiftResult["confidence"]) {
  switch (confidence) {
    case "high":
      return (
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
          high confidence shift
        </span>
      );
    case "moderate":
      return (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
          moderate shift
        </span>
      );
    case "none":
      return (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
          no shift
        </span>
      );
  }
}

function borderColor(confidence: TopicShiftResult["confidence"]) {
  switch (confidence) {
    case "high":
      return "border-red-300";
    case "moderate":
      return "border-amber-300";
    case "none":
      return "border-gray-200";
  }
}

function scoreColor(similarity: number, config: TopicShiftAnalysis["config"]) {
  if (similarity < config.highConfidenceShift) return "text-red-700";
  if (similarity < config.shiftThreshold) return "text-amber-700";
  return "text-gray-500";
}

function MessagePreview({ message }: { message: ChatMessage }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-1.5">
      <span className="text-xs font-semibold text-gray-400">
        {message.role === "user" ? "You" : "Assistant"}
      </span>
      <p className="mt-0.5 line-clamp-2 text-xs text-gray-700">
        {message.content}
      </p>
    </div>
  );
}

export default function TopicShiftsDebugPage() {
  const [analysis, setAnalysis] = useState<TopicShiftAnalysis | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAnalyze() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/debug/topic-shifts");
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Analysis failed.");
        return;
      }

      setAnalysis(data as TopicShiftAnalysis);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      {/* Header */}
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Debug · Internal
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Topic Shift Detection</h1>
        <p className="mt-1 text-sm text-gray-500">
          Slides two adjacent message windows across the conversation, embeds
          each window, and measures cosine similarity at each boundary. Low
          similarity = the conversation shifted to a new topic.
        </p>
      </div>

      {/* Analyze button */}
      <button
        onClick={handleAnalyze}
        disabled={isLoading}
        className="mb-6 flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isLoading ? (
          <>
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
            Analyzing…
          </>
        ) : (
          <>✦ Analyze conversation</>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Results */}
      {analysis && (
        <>
          {/* Config summary */}
          <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-600">
              <span>
                <span className="font-medium">Messages:</span>{" "}
                {analysis.messageCount}
              </span>
              <span>
                <span className="font-medium">Window size:</span>{" "}
                {analysis.config.windowSize}
              </span>
              <span>
                <span className="font-medium">Shift threshold:</span>{" "}
                <span className="font-mono">
                  {analysis.config.shiftThreshold.toFixed(2)}
                </span>
              </span>
              <span>
                <span className="font-medium">High confidence:</span>{" "}
                <span className="font-mono">
                  {analysis.config.highConfidenceShift.toFixed(2)}
                </span>
              </span>
            </div>
            <p className="mt-1.5 text-gray-500">
              {analysis.shifts.length} boundaries analyzed ·{" "}
              {analysis.detectedShifts.length} shift
              {analysis.detectedShifts.length === 1 ? "" : "s"} detected
            </p>
          </div>

          {/* Empty state */}
          {analysis.shifts.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
              Not enough messages to analyze. Need at least{" "}
              {analysis.config.windowSize * 2} messages (2 × window size).
              Currently have {analysis.messageCount}.
            </div>
          )}

          {/* Boundary cards */}
          {analysis.shifts.length > 0 && (
            <div className="space-y-4">
              {analysis.shifts.map((shift) => (
                <div
                  key={shift.boundaryIndex}
                  className={`rounded-xl border px-4 py-3 ${borderColor(shift.confidence)}`}
                >
                  {/* Header row */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-gray-400">
                        Boundary @ message #{shift.boundaryIndex}
                      </span>
                      {confidenceBadge(shift.confidence)}
                    </div>
                    <span
                      className={`font-mono text-xs ${scoreColor(shift.similarity, analysis.config)}`}
                    >
                      {shift.similarity.toFixed(4)}
                    </span>
                  </div>

                  {/* Windows */}
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    {/* Reference window */}
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-gray-400">
                        Reference window (before)
                      </p>
                      <div className="space-y-1.5">
                        {shift.referenceWindow.map((m) => (
                          <MessagePreview key={m.id} message={m} />
                        ))}
                      </div>
                    </div>

                    {/* Current window */}
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-gray-400">
                        Current window (after)
                      </p>
                      <div className="space-y-1.5">
                        {shift.currentWindow.map((m) => (
                          <MessagePreview key={m.id} message={m} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Legend */}
          <div className="mt-6 space-y-1 text-xs text-gray-400">
            <p className="font-medium text-gray-500">Confidence levels:</p>
            <div className="flex gap-5">
              <span>
                <span className="font-mono text-red-700">
                  &lt; {analysis.config.highConfidenceShift.toFixed(2)}
                </span>{" "}
                high confidence shift
              </span>
              <span>
                <span className="font-mono text-amber-700">
                  &lt; {analysis.config.shiftThreshold.toFixed(2)}
                </span>{" "}
                moderate shift
              </span>
              <span>
                <span className="font-mono text-gray-500">
                  ≥ {analysis.config.shiftThreshold.toFixed(2)}
                </span>{" "}
                no shift (continuity)
              </span>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
