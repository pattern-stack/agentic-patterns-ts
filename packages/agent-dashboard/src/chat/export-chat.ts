/**
 * export-chat — serialize a chat thread (`ChatMessage[]`) to clipboard-ready
 * text in one of three formats:
 *
 *   - `markdown`     a readable transcript; each tool call is a one-line
 *                    collapsed summary (name · status · duration), no I/O.
 *   - `markdown-io`  the same transcript, but every tool call carries its input
 *                    args + output (or error) as fenced JSON.
 *   - `json`         the full structured conversation (roles, parts, tokens).
 *
 * Pure + deterministic (no clock) so it unit-tests cleanly; the caller supplies
 * the agent name / conversation id as metadata.
 */
import type { ChatMessage, Part } from "./model";

export type ChatExportFormat = "markdown" | "markdown-io" | "json";

export interface ChatExportMeta {
  agentName?: string;
  conversationId?: string | null;
}

export function exportChat(
  messages: ChatMessage[],
  format: ChatExportFormat,
  meta: ChatExportMeta = {},
): string {
  return format === "json" ? exportJson(messages, meta) : exportMarkdown(messages, meta, format);
}

// ---------------------------------------------------------------------------
// JSON — the full structured thread
// ---------------------------------------------------------------------------

function exportJson(messages: ChatMessage[], meta: ChatExportMeta): string {
  return JSON.stringify(
    {
      agent: meta.agentName,
      conversationId: meta.conversationId ?? undefined,
      messages: messages.map((m) => ({
        role: m.role,
        ...(m.at != null ? { at: m.at } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.inputTokens != null ? { inputTokens: m.inputTokens } : {}),
        ...(m.outputTokens != null ? { outputTokens: m.outputTokens } : {}),
        parts: m.parts,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Markdown — a readable transcript
// ---------------------------------------------------------------------------

function speaker(role: string, agentName?: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return agentName ?? "Assistant";
  if (role === "system") return "System";
  return role;
}

function exportMarkdown(
  messages: ChatMessage[],
  meta: ChatExportMeta,
  format: ChatExportFormat,
): string {
  const toolIO = format === "markdown-io";
  const out: string[] = [`# Chat${meta.agentName ? ` — ${meta.agentName}` : ""}`, ""];
  for (const m of messages) {
    out.push(`### ${speaker(m.role, meta.agentName)}`);
    const body: string[] = [];
    for (const p of m.parts) renderPart(p, body, toolIO, 0);
    out.push(body.length > 0 ? body.join("\n") : "_(no content)_", "");
  }
  return `${out.join("\n").trim()}\n`;
}

const pad = (depth: number): string => "  ".repeat(depth);

function jsonStr(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** A fenced JSON block (input/output), indented to `depth`. */
function fence(label: string, value: unknown, depth: number): string[] {
  const lines = jsonStr(value).split("\n");
  return [
    `${pad(depth)}${label}:`,
    `${pad(depth)}\`\`\`json`,
    ...lines.map((l) => pad(depth) + l),
    `${pad(depth)}\`\`\``,
  ];
}

function renderPart(p: Part, out: string[], toolIO: boolean, depth: number): void {
  const at = pad(depth);
  switch (p.kind) {
    case "text":
      if (p.content.trim())
        out.push(
          p.content
            .split("\n")
            .map((l) => at + l)
            .join("\n"),
        );
      break;
    case "thinking":
      if (toolIO && p.content.trim()) {
        out.push(`${at}> 💭 ${p.content.replace(/\n/g, `\n${at}> `)}`);
      }
      break;
    case "tool_call": {
      const status = p.error ? "error" : p.rejected ? "rejected" : "ok";
      const dur = p.durationMs != null ? ` · ${p.durationMs}ms` : "";
      out.push(`${at}- 🔧 \`${p.name}\` — ${status}${dur}`);
      if (toolIO) {
        if (p.arguments !== undefined) out.push(...fence("input", p.arguments, depth + 1));
        if (p.error) out.push(`${pad(depth + 1)}error: ${p.error}`);
        else if (p.result !== undefined) out.push(...fence("output", p.result, depth + 1));
      }
      break;
    }
    case "agent_step": {
      const dur = p.durationMs != null ? ` · ${p.durationMs}ms` : "";
      out.push(`${at}- ▸ **${p.agentName ?? p.name}**${dur}`);
      for (const c of p.children) renderPart(c, out, toolIO, depth + 1);
      break;
    }
    case "input_request":
      out.push(`${at}- ⏸ input requested (${p.inputKind}): ${p.prompt}`);
      break;
    case "error":
      out.push(`${at}- ⚠ **${p.errorType}**: ${p.message}`);
      break;
    default:
      // state_delta / state_group — internal scratchpad frames, not part of the
      // conversation transcript. Omitted (they're in the JSON export's parts).
      break;
  }
}
