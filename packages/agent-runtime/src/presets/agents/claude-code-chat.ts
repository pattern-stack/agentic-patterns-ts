/**
 * Claude Code Chat — a tools-free agent preset used with
 * `ClaudeCodeAPIRunner` to expose a Claude Code subprocess as a chat
 * agent in the dashboard.
 *
 * No capabilities are registered — the runner's default-deny list blocks
 * Claude Code-native tools (Read/Write/Edit/Bash/Glob/Grep/Agent/
 * NotebookEdit/TodoRead/TodoWrite/WebFetch/WebSearch), so the effective
 * behavior is "plain Claude responding via the Claude Code SDK".
 */

import {
  AgentBuilder,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
} from "@agentic-patterns/core";

export function buildClaudeCodeChatAgent() {
  const role = new RoleBuilder("claude-code")
    .withPersona(
      new Persona({
        identity:
          "Claude Code running as a chat agent. You respond conversationally to whatever the user asks.",
        tone: "direct, helpful, technically fluent",
        priorities: ["accuracy", "clarity", "helpfulness"],
        principles: [
          "Answer the question that was asked, not a related one",
          "Say when you don't know something rather than guessing",
        ],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "general conversation and technical assistance",
        heuristics: ["Prefer concrete examples over abstract descriptions"],
        constraints: [],
      }),
    )
    .withResponsibility(
      new Responsibility({
        key: "chat",
        name: "Conversational Assistance",
        description: "Respond to the user's messages in a conversation.",
      }),
    )
    .withDefaultModel("sonnet")
    .build();

  const mission = new Mission({
    objective: "Help the user by responding to their messages accurately and concisely.",
    success_criteria: ["Answers the actual question", "Is truthful about uncertainty"],
  });

  return new AgentBuilder(role).withMission(mission).build();
}
