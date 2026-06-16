# Requirements Document

## Introduction

This feature adds AI-assisted title and summary generation to the "Create node" flow in ContextGraph. When a user selects one or more chat messages and opens the Create Node modal, they can click a "Generate suggestion" button to have a GPT-4o-mini model read the selected messages and propose a concise title and summary. The user may then edit the generated text freely before confirming. The feature requires a new backend API route; no database, auth, or embeddings are in scope.

## Glossary

- **ContextGraph**: The Next.js application being extended.
- **ChatMessage**: A typed object `{ id, role, content }` representing a single message in a conversation.
- **ContextNode**: A typed object `{ id, title, summary, messageIds }` saved to the graph.
- **CreateNodeModal**: The existing React component (`src/components/nodes/CreateNodeModal.tsx`) that collects a title and summary before confirming node creation.
- **Generate_Button**: The "Generate suggestion" button rendered inside `CreateNodeModal`.
- **API_Route**: The Next.js App Router route handler at `POST /api/generate-node-suggestion`.
- **OpenAI_Client**: The server-side module responsible for calling the OpenAI chat completion API.
- **Suggestion**: The AI-produced `{ title, summary }` object returned by the `API_Route`.

## Requirements

### Requirement 1: Generate Suggestion Button

**User Story:** As a user creating a context node, I want to click a "Generate suggestion" button inside the modal so that the title and summary fields are prefilled with AI-generated content based on the messages I selected.

#### Acceptance Criteria

1. THE `CreateNodeModal` SHALL render a "Generate suggestion" button when `selectedMessages` is non-empty.
2. WHEN the Generate_Button is clicked, THE `CreateNodeModal` SHALL only send the request if `selectedMessages` is non-empty; if `selectedMessages` is empty the button SHALL be disabled and no request SHALL be made.
3. WHEN a `Suggestion` is received, THE `CreateNodeModal` SHALL populate the title and summary fields with the returned values.
4. THE `CreateNodeModal` SHALL leave the title and summary fields editable after a `Suggestion` has been applied.
5. WHEN `selectedMessages` is empty, THE `CreateNodeModal` SHALL disable the Generate_Button.

### Requirement 2: Loading State During Generation

**User Story:** As a user, I want to see a loading indicator on the "Generate suggestion" button while the AI request is in progress so that I know the application is working.

#### Acceptance Criteria

1. WHILE a generation request is in flight, THE Generate_Button SHALL display a loading label (e.g., "Generating…") instead of its default label.
2. WHILE a generation request is in flight, THE Generate_Button SHALL be disabled to prevent duplicate submissions.
3. WHEN the generation request completes (success or failure), THE Generate_Button SHALL return to its default enabled state.

### Requirement 3: Inline Error Handling

**User Story:** As a user, I want to see a clear error message inside the modal when AI generation fails so that the modal remains usable and I can try again or type manually.

#### Acceptance Criteria

1. IF the `API_Route` returns a non-2xx response, THEN THE `CreateNodeModal` SHALL display an inline error message below the Generate_Button.
2. IF a network error occurs during the generation request, THEN THE `CreateNodeModal` SHALL display an inline error message below the Generate_Button.
3. WHEN an error is displayed, THE `CreateNodeModal` SHALL preserve any title and summary values already entered by the user.
4. THE `CreateNodeModal` SHALL NOT close or crash when a generation error occurs.
5. WHEN the user successfully triggers a new generation request, THE `CreateNodeModal` SHALL clear the previously displayed error message.

### Requirement 4: Backend API Route

**User Story:** As a developer, I want a dedicated API route that accepts selected messages and returns an AI-generated title and summary so that the client has a secure, server-side entry point for calling OpenAI.

#### Acceptance Criteria

1. THE `API_Route` SHALL accept `POST` requests at the path `/api/generate-node-suggestion`.
2. WHEN a `POST` request is received with a valid `messages` array, THE `API_Route` SHALL call the OpenAI chat completion API using model `gpt-4o-mini`.
3. WHEN the OpenAI API returns a valid response, THE `API_Route` SHALL return a JSON body `{ title: string, summary: string }` with HTTP status 200.
4. IF the request body is missing or malformed, THEN THE `API_Route` SHALL return HTTP status 400 with a descriptive error message.
4a. IF the `messages` array in the request body is empty (`[]`), THEN THE `API_Route` SHALL return HTTP status 400 with the message "messages array must not be empty".
5. IF the OpenAI API call fails, THEN THE `API_Route` SHALL return HTTP status 500 with a descriptive error message.
6. THE `API_Route` SHALL read the OpenAI API key from the `OPENAI_API_KEY` environment variable and SHALL NOT hard-code credentials.

### Requirement 5: Prompt Construction

**User Story:** As a developer, I want the AI prompt to be constructed from the selected messages in a structured way so that the generated title and summary are relevant and concise.

#### Acceptance Criteria

1. WHEN constructing the prompt, THE `OpenAI_Client` SHALL include the full `content` of every `ChatMessage` in `selectedMessages`, attributed by `role` (user or assistant).
2. THE `OpenAI_Client` SHALL instruct the model to return a title of at most 60 characters and a summary of at most 200 characters.
3. THE `OpenAI_Client` SHALL request a structured JSON response containing `title` and `summary` fields.
4. IF the model response cannot be parsed as valid JSON, OR the parsed JSON is missing the `title` or `summary` string fields, THEN THE `API_Route` SHALL return HTTP status 500 with a descriptive error message.

### Requirement 6: TypeScript Compilation

**User Story:** As a developer, I want all new code to be fully type-safe so that the project continues to pass `npx tsc --noEmit` without errors.

#### Acceptance Criteria

1. THE ContextGraph application SHALL compile without TypeScript errors after the feature is implemented (`npx tsc --noEmit`).
2. THE `API_Route` request and response types SHALL be explicitly typed.
3. THE `CreateNodeModal` props and internal state additions SHALL be explicitly typed.
