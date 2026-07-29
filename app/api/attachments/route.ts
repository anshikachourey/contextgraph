import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/src/lib/supabase/server";
import { requireSession, requireConversationAccess, isAuthError } from "@/src/lib/auth";

const BUCKET = "chat-attachments";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

/**
 * POST /api/attachments — Upload a file to private storage.
 * Validates conversation ownership, MIME type, file size, and filename.
 * Returns the storage path and a signed URL for immediate use.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const db = createServerSupabaseClient();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Request must be multipart/form-data." }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const conversationId = formData.get("conversationId") as string | null;

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field." }, { status: 400 });
  }
  if (!conversationId || typeof conversationId !== "string") {
    return NextResponse.json({ error: "Missing 'conversationId' field." }, { status: 400 });
  }

  // Verify conversation ownership
  const access = await requireConversationAccess(conversationId, session);
  if (isAuthError(access)) return access;

  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type "${file.type}". Allowed: JPEG, PNG, GIF, WebP, PDF, plain text.` },
      { status: 415 },
    );
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File exceeds the 10 MB size limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).` },
      { status: 413 },
    );
  }

  // Validate filename (sanitize)
  if (!file.name || file.name.length > 255) {
    return NextResponse.json({ error: "Invalid filename." }, { status: 400 });
  }

  // Build storage path
  const uuid = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const storagePath = `${conversationId}/${uuid}-${safeName}`;

  // Upload via service role (bypasses RLS)
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await db.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadErr) {
    console.error("[attachments] Upload failed:", uploadErr);
    return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  // Generate signed URL for immediate use
  const { data: signedData, error: signErr } = await db.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);

  if (signErr || !signedData?.signedUrl) {
    return NextResponse.json({ error: "Upload succeeded but signed URL generation failed." }, { status: 500 });
  }

  return NextResponse.json({
    storagePath,
    url: signedData.signedUrl,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  }, { status: 201 });
}

/**
 * GET /api/attachments?paths=path1,path2,...
 * Generate signed URLs for one or more stored attachments.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (isAuthError(session)) return session;

  const { searchParams } = new URL(request.url);
  const pathsParam = searchParams.get("paths");

  if (!pathsParam) {
    return NextResponse.json({ error: "Missing 'paths' query parameter." }, { status: 400 });
  }

  const paths = pathsParam.split(",").filter(Boolean);
  if (paths.length === 0 || paths.length > 20) {
    return NextResponse.json({ error: "Provide 1-20 paths." }, { status: 400 });
  }

  // Verify ownership: paths are formatted as {conversationId}/{uuid}-{filename}
  // Extract unique conversation IDs and verify each
  const conversationIds = new Set<string>();
  for (const p of paths) {
    const convId = p.split("/")[0];
    if (convId) conversationIds.add(convId);
  }

  for (const convId of conversationIds) {
    const access = await requireConversationAccess(convId, session);
    if (isAuthError(access)) return access;
  }

  const db = createServerSupabaseClient();

  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS);

  if (error) {
    return NextResponse.json({ error: `Signed URL generation failed: ${error.message}` }, { status: 500 });
  }

  const urls: Record<string, string | null> = {};
  for (const item of data ?? []) {
    urls[item.path ?? ""] = item.signedUrl ?? null;
  }

  return NextResponse.json({ urls, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS });
}
