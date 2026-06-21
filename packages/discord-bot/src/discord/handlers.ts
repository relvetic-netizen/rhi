import type {
  ChatInputCommandInteraction,
  Message,
  TextBasedChannel,
  AnyThreadChannel,
} from "discord.js";
import type { Session } from "../session/session.js";
import type { SDKResultMessage, SDKAssistantMessage } from "../types.js";
import { StreamingResponse } from "../response/streaming.js";
import { PermissionHandler } from "../claude/permissions.js";
import { formatAssistantMessage } from "../response/formatter.js";

/** Swap the in-progress 👀 reaction for the completion status reaction. */
export async function markProcessed(
  msg: Message,
  clientId: string,
  status: "ok" | "err"
): Promise<void> {
  await msg.reactions.cache.get("👀")?.users.remove(clientId).catch(() => undefined);
  await msg.react(status === "ok" ? "✅" : "❌").catch(() => undefined);
}

export type ReplyTarget =
  | { type: "interaction"; interaction: ChatInputCommandInteraction }
  | { type: "message"; message: Message }
  | { type: "thread"; thread: AnyThreadChannel; originalMessage: Message };

export async function handleTurn(
  session: Session,
  prompt: string,
  target: ReplyTarget
): Promise<void> {
  const channel = (
    target.type === "interaction"
      ? target.interaction.channel!
      : target.type === "thread"
        ? target.thread
        : target.message.channel
  ) as TextBasedChannel;

  const streaming = new StreamingResponse(channel, target);
  const permissions = new PermissionHandler(session, channel);

  return new Promise<void>((resolve, reject) => {
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      session.router.removeListener("text_delta", onTextDelta);
      session.router.removeListener("assistant", onAssistant);
      session.router.removeListener("result", onResult);
      session.router.removeListener("permission_request", onPermission);
      session.router.removeListener("tool_use", onToolUse);
      session.router.removeListener("error", onError);
      session.subprocess.removeListener("exit", onExit);
    };

    const onTextDelta = (text: string) => {
      streaming.appendDelta(text);
    };

    const onAssistant = (msg: SDKAssistantMessage) => {
      const formatted = formatAssistantMessage(msg);
      if (formatted) {
        streaming.setFinalContent(formatted);
      }
    };

    const onResult = async (msg: SDKResultMessage) => {
      cleanup();
      try {
        let footer = "";
        if (msg.subtype !== "success" && "errors" in msg && msg.errors.length > 0) {
          footer = `\n**Error:** ${msg.errors.join(", ")}`;
        }
        await streaming.finalize(footer);
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    const onPermission = permissions.handle.bind(permissions);

    const onToolUse = (toolName: string, input: Record<string, unknown>) => {
      streaming.appendToolUse(toolName, input);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = () => {
      cleanup();
      streaming.finalize("\n*Session ended unexpectedly.*").then(resolve, reject);
    };

    session.router.on("text_delta", onTextDelta);
    session.router.on("assistant", onAssistant);
    session.router.on("result", onResult);
    session.router.on("permission_request", onPermission);
    session.router.on("tool_use", onToolUse);
    session.router.on("error", onError);
    session.subprocess.once("exit", onExit);

    session.sendMessage(prompt).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}
