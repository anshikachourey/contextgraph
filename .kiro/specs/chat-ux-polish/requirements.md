# Requirements Document

## Introduction

This spec addresses five UX quality issues in the ContextGraph chat interface to bring it to parity with modern AI chat products (ChatGPT, Claude). The scope is strictly the chat experience pipeline — from the composer input through the API route, model call, response handling, persistence, and frontend rendering. No semantic-engine work is in scope.

The current state (identified via codebase audit):
- `maxTokens` is hardcoded to **512** in `src/lib/ai/chat.ts`, causing premature truncation of assistant responses.
- The chat input uses a single-line `<input>` element with no multiline or growth capability.
- Assistant message content is rendered via `whitespace-pre-wrap` with no Markdown processing.
- The `/api/chat` route awaits the full completion before returning JSON — no streaming.
- The message schema (`ChatMessage`) carries only `content: string` with no attachment fields, and there is no file upload or storage infrastructure.

## Glossary

- **Chat_Composer**: The frontend text input component (`ChatInput.tsx`) where users type prompts.
- **Chat_API**: The Next.js API route at `/api/chat/route.ts` that orchestrates model calls.
- **Provider_Layer**: The abstraction in `src/lib/ai/provider.ts` that routes requests to OpenAI or Anthropic SDKs.
- **Chat_Panel**: The `ChatPanel.tsx` component that renders the message list and input.
- **Message_Renderer**: The `ChatMessage.tsx` component responsible for displaying individual messages.
- **Message_Schema**: The TypeScript type and Supabase `messages` table structure defining what data a message carries.
- **Attachment**: A user-uploaded file (image or document) associated with a message, stored in Supabase Storage.
- **Stream_Response**: A server-sent event (SSE) or ReadableStream response delivering tokens progressively to the frontend.

## Requirements

### Requirement 1: Eliminate Artificial Response Truncation

**User Story:** As a user, I want assistant responses to be delivered in full without being cut off, so that I do not need to type "continue" to see the rest of a response.

#### Acceptance Criteria

1. WHEN generating a chat response, THE Provider_Layer SHALL use a default max_tokens value of 4096 for the chat completion model.
2. THE Chat_API SHALL NOT impose a token limit below 4096 tokens unless the caller explicitly provides a lower limit in the request body.
3. IF the model returns a response with a `stop_reason` of "max_tokens" (indicating the response was truncated by the limit), THEN THE Chat_API SHALL log a warning including the conversation ID (if available in the request context) and the token count used.
4. WHEN the caller provides an explicit `maxTokens` override in the request body, THE Chat_API SHALL use the caller-specified value instead of the default, provided the value is an integer between 1 and 16384 inclusive.
5. IF the caller provides a `maxTokens` value that is not an integer or falls outside the range of 1 to 16384, THEN THE Chat_API SHALL reject the request with a 400 status and an error message indicating the allowed range.

### Requirement 2: Multi-Line Auto-Growing Chat Input

**User Story:** As a user, I want to compose long, multi-line prompts comfortably, so that I can write detailed questions without fighting the input field.

#### Acceptance Criteria

1. THE Chat_Composer SHALL render a multi-line `<textarea>` element instead of a single-line `<input>` element with an initial height of one text row.
2. WHEN the user types or pastes text that exceeds the visible width, THE Chat_Composer SHALL wrap text to the next line within the textarea.
3. WHEN the content height changes, THE Chat_Composer SHALL auto-grow its height to fit the content, starting from the one-row initial height up to a maximum of 200 pixels.
4. WHILE the content height exceeds 200 pixels, THE Chat_Composer SHALL display a vertical scrollbar and maintain the 200-pixel maximum height.
5. WHEN the user presses Enter without holding Shift and the textarea contains at least one non-whitespace character, THE Chat_Composer SHALL submit the message.
6. IF the user presses Enter without holding Shift and the textarea is empty or contains only whitespace, THEN THE Chat_Composer SHALL not submit and SHALL retain focus on the textarea.
7. WHEN the user presses Shift+Enter, THE Chat_Composer SHALL insert a newline character at the cursor position.
8. WHEN a message is successfully sent, THE Chat_Composer SHALL clear the textarea content and reset its height to the one-row initial height.

### Requirement 3: Markdown Rendering for Assistant Responses

**User Story:** As a user, I want assistant responses to render rich formatting (headings, bold, lists, links, code blocks), so that technical answers are readable and well-structured.

#### Acceptance Criteria

1. WHEN an assistant message contains Markdown syntax, THE Message_Renderer SHALL render the Markdown as formatted HTML instead of displaying raw syntax characters.
2. THE Message_Renderer SHALL support rendering of: headings (h1–h6), bold text, italic text, unordered lists, ordered lists, inline code, fenced code blocks, links, and blockquotes.
3. WHEN rendering fenced code blocks, THE Message_Renderer SHALL display the code in a monospace font with a visually distinct background, include horizontal scrolling for lines exceeding the container width, and display the language identifier as a label when a language is specified in the fence.
4. WHEN rendering links whose href points to a different origin than the application, THE Message_Renderer SHALL open those links in a new browser tab with `rel="noopener noreferrer"` for security.
5. THE Message_Renderer SHALL NOT render Markdown in user messages; user messages SHALL continue to display as plain text with whitespace preserved.
6. WHEN rendering Markdown, THE Message_Renderer SHALL strip all raw HTML tags and script elements from the source before rendering, producing output that contains only HTML generated by the Markdown parser itself.
7. IF the assistant message contains Markdown syntax that is malformed or incomplete (e.g., unclosed fences, mismatched delimiters), THEN THE Message_Renderer SHALL render the valid portions as formatted HTML and display the malformed portions as plain text rather than hiding or discarding content.

### Requirement 4: Progressive Streaming of Assistant Responses

**User Story:** As a user, I want to see assistant responses appear progressively word-by-word as the model generates them, so that I get faster perceived feedback and can begin reading immediately.

#### Acceptance Criteria

1. WHEN the Chat_API receives a valid chat request, THE Chat_API SHALL return a streaming response (using ReadableStream or Server-Sent Events) instead of waiting for the full completion.
2. WHILE the Provider_Layer receives tokens from the model, THE Provider_Layer SHALL yield each token chunk to the stream within 50 milliseconds of receipt from the upstream model.
3. WHILE streaming tokens, THE Chat_Panel SHALL append received text to the assistant message bubble within 100 milliseconds of each chunk arrival, rendering partial Markdown progressively such that incomplete Markdown syntax (e.g., unclosed code fences) does not produce rendering errors.
4. WHEN the stream completes, THE Chat_Panel SHALL mark the assistant response as finalized and persist the complete message content.
5. IF the stream encounters an error mid-response (including network disconnection or model failure), THEN THE Chat_Panel SHALL display the partial content already received plus an inline error indicator, and SHALL NOT discard the partial response.
6. WHILE streaming is in progress, THE Chat_Composer SHALL remain disabled to prevent concurrent submissions.
7. WHEN streaming completes or errors, THE Chat_Composer SHALL re-enable for new input.
8. IF no new token is received for 30 seconds while streaming is in progress, THEN THE Chat_Panel SHALL treat the stream as timed out, display the partial content already received with an inline timeout indicator, and re-enable the Chat_Composer.

### Requirement 5: File and Image Attachments

**User Story:** As a user, I want to attach images and files to my prompts and have the model actually receive and reason about them, so that I can get help with visual content or documents.

#### Acceptance Criteria

1. WHEN the user clicks the attachment button, THE Chat_Composer SHALL open the system file picker allowing selection of one or more files.
2. WHEN the user selects one or more files, THE Chat_Composer SHALL display a thumbnail preview (maximum 80×80 pixels) for images and a filename label for non-image files below the text input, each with a remove button to discard individual attachments before sending.
3. THE Chat_Composer SHALL accept files of type: images (JPEG, PNG, GIF, WebP), PDF, and plain text, with a maximum individual file size of 10 MB and a maximum of 5 attachments per message.
4. IF the user selects a file exceeding 10 MB or of an unsupported type, THEN THE Chat_Composer SHALL display an inline error message indicating the reason for rejection and reject only the invalid file while retaining any valid files already attached.
5. WHEN a message with attachments is submitted, THE Chat_Composer SHALL upload each attachment to Supabase Storage and include the storage URLs in the message payload sent to the Chat_API.
6. IF an attachment upload to Supabase Storage fails, THEN THE Chat_Composer SHALL display an inline error message indicating the upload failure, retain the message and attachments in the composer without clearing, and not send the message.
7. WHEN the Chat_API receives a message with attachment URLs, THE Chat_API SHALL include the attachments in the model request using the provider's native multimodal format (Anthropic image blocks or OpenAI image_url content parts for images, and text content extraction for PDF and plain text files).
8. THE Message_Schema SHALL include an `attachments` field that stores an array of attachment metadata (storage URL, original filename, MIME type, byte size) for each message.
9. WHEN rendering a message with attachments, THE Message_Renderer SHALL display image attachments as inline previews scaled to a maximum width of 400 pixels maintaining aspect ratio, and non-image attachments as downloadable file links showing filename and file size.
10. WHEN a conversation is loaded from the database, THE Chat_Panel SHALL display persisted attachments alongside the message content they belong to.
