import { describe, expect, it } from "vitest";
import { exportChat } from "../export-chat";
import type { ChatMessage } from "../model";

const THREAD: ChatMessage[] = [
  { id: "u1", role: "user", parts: [{ kind: "text", content: "List my meetings." }] },
  {
    id: "a1",
    role: "assistant",
    model: "haiku",
    parts: [
      {
        kind: "tool_call",
        id: "t1",
        name: "list_meetings",
        arguments: { limit: 5 },
        result: { meetings: ["standup"] },
        durationMs: 20,
      },
      { kind: "text", content: "You have 1 meeting: standup." },
    ],
  },
];

describe("exportChat", () => {
  it("markdown (collapsed) summarizes tool calls as one line, no I/O", () => {
    const md = exportChat(THREAD, "markdown", { agentName: "Workspace" });
    expect(md).toContain("# Chat — Workspace");
    expect(md).toContain("### You");
    expect(md).toContain("List my meetings.");
    expect(md).toContain("### Workspace");
    expect(md).toContain("- 🔧 `list_meetings` — ok · 20ms");
    expect(md).toContain("You have 1 meeting: standup.");
    // collapsed → the args/result JSON must NOT appear
    expect(md).not.toContain('"limit"');
    expect(md).not.toContain('"meetings"');
  });

  it("markdown-io includes each tool call's input + output", () => {
    const md = exportChat(THREAD, "markdown-io", { agentName: "Workspace" });
    expect(md).toContain("- 🔧 `list_meetings` — ok · 20ms");
    expect(md).toContain("input:");
    expect(md).toContain('"limit": 5');
    expect(md).toContain("output:");
    expect(md).toContain('"meetings"');
  });

  it("json emits the full structured thread", () => {
    const json = exportChat(THREAD, "json", { agentName: "Workspace", conversationId: "c1" });
    const parsed = JSON.parse(json) as {
      agent: string;
      conversationId: string;
      messages: { role: string; parts: unknown[] }[];
    };
    expect(parsed.agent).toBe("Workspace");
    expect(parsed.conversationId).toBe("c1");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[1]?.parts).toHaveLength(2);
  });

  it("renders an error tool call and the honest empty-content fallback", () => {
    const md = exportChat(
      [
        {
          id: "a2",
          role: "assistant",
          parts: [{ kind: "tool_call", id: "t2", name: "boom", error: "kaboom" }],
        },
        { id: "a3", role: "assistant", parts: [] },
      ],
      "markdown-io",
    );
    expect(md).toContain("- 🔧 `boom` — error");
    expect(md).toContain("error: kaboom");
    expect(md).toContain("_(no content)_");
  });
});
