# Implementation Plan: Chat UX Polish

## Overview

This plan implements five chat UX improvements in dependency order: provider-layer token limit fix, multi-line composer, Markdown rendering, progressive streaming, and file attachments. Each step builds incrementally on the previous, ending with full integration wiring.

## Tasks

- [x] 1. Provider layer: raise default maxTokens and add streaming support
  - [x] 1.1 Update default maxTokens from 512 to 4096 in `src/lib/ai/provider.ts`
    - Change the fallback `maxTokens` value from 512 to 4096 in both `openaiComplete` and `anthropicComplete` functions
    - Add `maxTokens` validation logic: accept integers in [1, 16384], reject with descriptive error otherwise
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

  - [ ]* 1.2 Write property test for maxTokens validation (Property 1)
    - **Property 1: maxTokens Validation**
    - Use fast-check to generate random integers, floats, strings, and out-of-range numbers
    - Assert: accepted iff integer ∈ [1, 16384]; all others rejected with 400
    - **Validates: Requirements 1.4, 1.5**

  - [x] 1.3 Implement `completeStream()` in `src/lib/ai/provider.ts`
    - Add `StreamChunk` type (`token | done | error`) and `StreamCompletionOptions` type
    - Implement `openaiCompleteStream` using OpenAI SDK streaming
    - Implement `anthropicCompleteStream` using Anthropic SDK streaming
    - Both use 4096 as default maxTokens
    - _Requirements: 4.1, 4.2_

  - [x] 1.4 Add `streamChatResponse()` to `src/lib/ai/chat.ts`
    - Create function returning a `ReadableStream<Uint8Array>` encoding newline-delimited JSON
    - Each chunk: `{"type":"token","content":"..."}`, final: `{"type":"done","stopReason":"..."}`
    - On error: `{"type":"error","error":"..."}`
    - _Requirements: 4.1, 4.2_

- [x] 2. Chat API route: streaming response and maxTokens validation
  - [x] 2.1 Update `/api/chat/route.ts` to support streaming responses
    - Change POST handler return type from `NextResponse.json` to `new Response(readableStream)`
    - Set Content-Type to `text/plain; charset=utf-8`
    - Validate `maxTokens` if provided in request body (integer in [1, 16384] or 400)
    - Log warning when model returns `stop_reason: "max_tokens"` including conversation ID and token count
    - Keep backward-compatible: branchContext logic unchanged
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 4.1_

  - [ ]* 2.2 Write unit tests for chat route maxTokens validation and streaming
    - Test default maxTokens = 4096 when no override provided
    - Test valid override is passed through
    - Test invalid override returns 400
    - Test truncation warning logged on max_tokens stop_reason
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 3. Checkpoint — Provider and API streaming
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Multi-line auto-growing chat composer
  - [x] 4.1 Rewrite `src/components/chat/ChatInput.tsx` from `<input>` to `<textarea>`
    - Replace `<input>` with `<textarea>` element
    - Use `useRef` for DOM access and `useEffect` for auto-height on value change
    - Initial height: one text row; auto-grow up to 200px max
    - Show vertical scrollbar when content exceeds 200px
    - Keyboard handling: Enter (no Shift) = submit if non-whitespace content; Shift+Enter = newline
    - Clear textarea and reset height after successful send
    - Empty/whitespace-only Enter does not submit
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [ ]* 4.2 Write property test for textarea auto-grow height clamping (Property 2)
    - **Property 2: Textarea Auto-Grow Height Clamping**
    - Use fast-check to generate arbitrary multiline strings
    - Assert: computed height ≥ single-row height AND ≤ 200px
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 4.3 Write property test for Enter submission logic (Property 3)
    - **Property 3: Enter Submission Logic**
    - Use fast-check to generate random strings (including whitespace-only)
    - Assert: submission occurs iff string contains at least one non-whitespace character
    - **Validates: Requirements 2.5, 2.6**

  - [ ]* 4.4 Write property test for clear-and-reset after send (Property 4)
    - **Property 4: Clear and Reset After Send**
    - Assert: after any successful submission, textarea value is empty and height equals initial row height
    - **Validates: Requirements 2.8**

- [x] 5. Markdown rendering for assistant messages
  - [x] 5.1 Install `react-markdown`, `remark-gfm`, and `rehype-sanitize` dependencies
    - Add to package.json dependencies: `react-markdown@^9`, `remark-gfm@^4`, `rehype-sanitize@^6`
    - Run install
    - _Requirements: 3.1_

  - [x] 5.2 Update `src/components/chat/ChatMessage.tsx` to render Markdown for assistant messages
    - For assistant messages: replace `<p className="whitespace-pre-wrap">` with `<ReactMarkdown>` using `remarkGfm` and `rehypeSanitize` plugins
    - Create custom `CodeBlock` component: monospace font, distinct background, horizontal scroll, language label
    - Create custom `ExternalLink` component: detect cross-origin hrefs, add `target="_blank" rel="noopener noreferrer"`
    - User messages: keep plain text rendering with `whitespace-pre-wrap`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 5.3 Write property test for Markdown rendering completeness (Property 5)
    - **Property 5: Markdown Rendering Completeness**
    - Use fast-check to generate arbitrary Markdown strings (valid and malformed)
    - Assert: all textual content from source is present in rendered output (no discarded content)
    - **Validates: Requirements 3.1, 3.7**

  - [ ]* 5.4 Write property test for external link security (Property 7)
    - **Property 7: External Link Security**
    - Use fast-check to generate Markdown links with random origins
    - Assert: cross-origin links have `target="_blank"` and `rel="noopener noreferrer"`
    - **Validates: Requirements 3.4**

  - [ ]* 5.5 Write property test for user message plain text preservation (Property 8)
    - **Property 8: User Message Plain Text Preservation**
    - Use fast-check to generate strings with Markdown syntax characters
    - Assert: rendered output displays raw characters without Markdown interpretation
    - **Validates: Requirements 3.5**

  - [ ]* 5.6 Write property test for HTML sanitization (Property 9)
    - **Property 9: HTML Sanitization**
    - Use fast-check to generate strings with HTML tags and script elements
    - Assert: rendered output contains zero raw HTML elements from source
    - **Validates: Requirements 3.6**

- [x] 6. Checkpoint — Composer and Markdown rendering
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Progressive streaming frontend integration
  - [x] 7.1 Create `useStreamChat` hook in `src/hooks/useStreamChat.ts`
    - Fetch `/api/chat` and read response body as `ReadableStream`
    - Parse newline-delimited JSON chunks
    - Update message state progressively on each `token` chunk
    - Handle `done` chunk: mark response as finalized, trigger persistence
    - Handle `error` chunk: display partial content + inline error indicator
    - Implement 30-second timeout: if no token received for 30s, show partial + timeout indicator
    - Return: `{ sendMessage, isStreaming, streamError }`
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 7.2 Integrate `useStreamChat` into `app/page.tsx` replacing `handleSendMessage` fetch logic
    - Replace the current `await fetch → json()` pattern with the streaming hook
    - Disable Chat_Composer while streaming is in progress
    - Re-enable on stream completion or error
    - Persist complete message to `/api/messages` on stream done
    - Display partial content + error indicator on mid-stream failure
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ]* 7.3 Write property test for partial Markdown streaming stability (Property 10)
    - **Property 10: Partial Markdown Streaming Stability**
    - Use fast-check to generate valid Markdown strings, slice at arbitrary byte positions
    - Assert: rendering partial content does not throw or produce uncaught exceptions
    - **Validates: Requirements 4.3**

- [x] 8. Checkpoint — Streaming end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. File and image attachments: schema, storage, and upload
  - [x] 9.1 Create Supabase migration for `attachments` JSONB column and storage bucket
    - Add `attachments JSONB DEFAULT NULL` column to `messages` table
    - Create `chat-attachments` storage bucket (public)
    - Add RLS policies: authenticated users can upload, public can read
    - _Requirements: 5.8_

  - [x] 9.2 Update `ChatMessage` type in `src/types/message.ts` to include `attachments` field
    - Add `AttachmentMeta` type: `{ url, filename, mimeType, size }`
    - Add optional `attachments?: AttachmentMeta[] | null` field to `ChatMessage`
    - _Requirements: 5.8_

  - [x] 9.3 Create attachment utility module `src/lib/attachments.ts`
    - Export allowed MIME types, max file size (10MB), max attachments (5)
    - Implement `validateFile(file: File)` returning `{ valid, error? }`
    - Implement `uploadAttachment(file, conversationId)` returning `AttachmentMeta`
    - Upload path: `chat-attachments/{conversationId}/{uuid}-{filename}`
    - _Requirements: 5.3, 5.4, 5.5_

  - [ ]* 9.4 Write property test for file validation (Property 11)
    - **Property 11: File Validation**
    - Use fast-check to generate random MIME types, file sizes, and attachment counts
    - Assert: accepted iff MIME in allowed set AND size ≤ 10MB AND count ≤ 5; invalid files rejected individually
    - **Validates: Requirements 5.3, 5.4**

- [x] 10. File and image attachments: composer UI
  - [x] 10.1 Add attachment UI to `src/components/chat/ChatInput.tsx`
    - Add attachment button that triggers hidden file input
    - Display thumbnail previews (80×80px max) for images, filename labels for non-images
    - Add remove button per attachment
    - Validate files on selection: reject invalid with inline error, retain valid
    - On submit: upload all attachments via `uploadAttachment()`, include URLs in message payload
    - Handle upload failure: show inline error, retain composer state, don't send
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 11. File and image attachments: API and rendering
  - [x] 11.1 Create multimodal formatting utility `src/lib/ai/multimodal.ts`
    - Implement `buildMultimodalContent(text, attachments, provider)` returning provider-native content parts
    - Images → Anthropic `image` blocks / OpenAI `image_url` parts
    - PDF/text → download and include as text content parts
    - _Requirements: 5.7_

  - [ ]* 11.2 Write property test for multimodal format transformation (Property 12)
    - **Property 12: Multimodal Format Transformation**
    - Use fast-check to generate random attachment metadata arrays
    - Assert: images produce image blocks, PDF/text produce text parts, all attachments represented
    - **Validates: Requirements 5.7**

  - [x] 11.3 Update `/api/chat/route.ts` to handle attachments in multimodal format
    - When message payload includes attachment URLs, call `buildMultimodalContent` to format for provider
    - Pass formatted content to `streamChatResponse`
    - _Requirements: 5.7_

  - [x] 11.4 Update `src/components/chat/ChatMessage.tsx` to render attachments
    - Image attachments: inline preview, max-width 400px, maintain aspect ratio
    - Non-image attachments: downloadable link with filename and file size
    - Load persisted attachments alongside message content
    - _Requirements: 5.2, 5.9, 5.10_

  - [ ]* 11.5 Write property test for attachment rendering by type (Property 13)
    - **Property 13: Attachment Rendering by Type**
    - Use fast-check to generate message attachment arrays with mixed MIME types
    - Assert: images render as previews (max-width 400px), non-images render as download links
    - **Validates: Requirements 5.2, 5.9**

- [x] 12. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between major feature areas
- Property tests validate universal correctness properties from the design using fast-check
- Unit tests validate specific examples and edge cases using vitest
- The project uses Vitest as test runner; fast-check integrates directly with `it`/`test` blocks
- All code is TypeScript targeting Next.js 16 App Router with React 19

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1", "9.1", "9.2"] },
    { "id": 1, "tasks": ["1.2", "1.3", "4.1", "5.2", "9.3"] },
    { "id": 2, "tasks": ["1.4", "4.2", "4.3", "4.4", "5.3", "5.4", "5.5", "5.6", "9.4"] },
    { "id": 3, "tasks": ["2.1", "10.1", "11.1"] },
    { "id": 4, "tasks": ["2.2", "7.1", "11.2", "11.3"] },
    { "id": 5, "tasks": ["7.2", "11.4"] },
    { "id": 6, "tasks": ["7.3", "11.5"] }
  ]
}
```
