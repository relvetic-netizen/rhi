import type { SDKAssistantMessage, ContentBlock } from "../types.js";

export function formatAssistantMessage(msg: SDKAssistantMessage): string {
  const parts: string[] = [];

  for (const block of msg.message.content) {
    switch (block.type) {
      case "text":
        if (block.text) {
          parts.push(block.text);
        }
        break;
      case "tool_use":
        parts.push(formatToolUse(block));
        break;
    }
  }

  return parts.join("\n");
}

function formatToolUse(block: ContentBlock): string {
  const name = block.name || "Unknown Tool";
  const input = block.input || {};

  let preview = "";
  if (name === "Bash" && typeof input.command === "string") {
    preview = truncate(input.command, 100);
  } else if (name === "Read" && typeof input.file_path === "string") {
    preview = input.file_path;
  } else if (name === "Write" && typeof input.file_path === "string") {
    preview = input.file_path;
  } else if (name === "Edit" && typeof input.file_path === "string") {
    preview = input.file_path;
  } else if (name === "Grep" && typeof input.pattern === "string") {
    preview = truncate(input.pattern, 60);
  } else if (name === "Glob" && typeof input.pattern === "string") {
    preview = input.pattern;
  } else {
    const keys = Object.keys(input);
    preview = keys.length > 0 ? keys.join(", ") : "";
  }

  return preview
    ? `*> ${name}: \`${preview}\`*`
    : `*> ${name}*`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
