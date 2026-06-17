import { NextRequest, NextResponse } from "next/server";
import { persistNode } from "@/src/lib/db/nodes";
import type { ContextNode } from "@/src/types/node";
import type { NodeMetadata } from "@/src/types/db";

type NodesRequest = {
  conversationId: string;
  node: ContextNode;
  metadata?: NodeMetadata;
};

type ErrorResponse = { error: string };

export async function POST(
  request: NextRequest,
): Promise<NextResponse<Record<string, never> | ErrorResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;

  if (typeof b.conversationId !== "string" || typeof b.node !== "object" || !b.node) {
    return NextResponse.json(
      { error: "Request must include conversationId and node." },
      { status: 400 },
    );
  }

  try {
    await persistNode(
      b.conversationId,
      b.node as ContextNode,
      (b.metadata as NodeMetadata) ?? {},
    );
    return NextResponse.json({}, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to persist node: ${message}` },
      { status: 500 },
    );
  }
}
