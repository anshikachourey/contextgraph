import { NextResponse } from "next/server";
import { loadLatestConversation } from "@/src/lib/db/conversations";
import { detectTopicShifts, type TopicShiftAnalysis } from "@/src/lib/topicShiftDetector";

type SuccessResponse = TopicShiftAnalysis;
type ErrorResponse = { error: string };

/**
 * GET /api/debug/topic-shifts
 *
 * Analyzes the current conversation for semantic topic shifts.
 * Returns all window boundaries with similarity scores and confidence levels.
 *
 * Each call generates 2 embeddings per window boundary — use sparingly.
 * For a conversation with N messages and window size W, this makes
 * (N - 2W + 1) * 2 embedding API calls.
 *
 * Not intended for production — validation/tuning only.
 */
export async function GET(): Promise<
  NextResponse<SuccessResponse | ErrorResponse>
> {
  try {
    const data = await loadLatestConversation();

    if (!data) {
      return NextResponse.json(
        { error: "No conversation found." },
        { status: 404 },
      );
    }

    const analysis = await detectTopicShifts(data.messages);

    return NextResponse.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Topic shift analysis failed: ${message}` },
      { status: 500 },
    );
  }
}
