import type { ChatMessage } from "@/src/types/message";

export const mockMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Help me plan my AI startup.",
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "Let's start by identifying the core user problem, target audience, and first MVP loop.",
  },
  {
    id: "m3",
    role: "user",
    content:
      "The problem is that long AI chats become hard to navigate and the assistant loses context.",
  },
];
