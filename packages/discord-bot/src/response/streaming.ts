import {
  type TextBasedChannel,
  type Message,
  type ChatInputCommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import type { ReplyTarget } from "../discord/handlers.js";
import {
  splitMessage,
  shouldAttachAsFile,
  createFileAttachment,
} from "./splitter.js";

const EDIT_INTERVAL_MS = 1500;
const MAX_STREAMING_LENGTH = 1900;

export class StreamingResponse {
  private channel: TextBasedChannel;
  private target: ReplyTarget;
  private buffer = "";
  private finalContent = "";
  private sentMessage: Message | null = null;
  private editTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private finalized = false;
  private toolUses: string[] = [];

  constructor(channel: TextBasedChannel, target: ReplyTarget) {
    this.channel = channel;
    this.target = target;
  }

  appendDelta(text: string): void {
    if (this.finalized) return;
    this.buffer += text;
    this.dirty = true;

    if (!this.editTimer) {
      this.startEditLoop();
    }
  }

  appendToolUse(_toolName: string, _input: Record<string, unknown>): void {
    // Tool use history is intentionally not shown to users
  }

  setFinalContent(content: string): void {
    this.finalContent = content;
  }

  async finalize(footer = ""): Promise<void> {
    this.finalized = true;
    this.stopEditLoop();

    const content = this.finalContent || this.buffer;
    const fullText = content + footer;

    if (!fullText.trim()) {
      await this.sendOrEdit("*(No response)*");
      return;
    }

    if (shouldAttachAsFile(fullText)) {
      const preview = content.slice(0, 1500) + "\n\n*... (full response attached)*";
      const file = createFileAttachment(fullText);
      await this.sendOrEdit(preview + footer, [file]);
    } else {
      const chunks = splitMessage(fullText);
      await this.sendOrEdit(chunks[0]!);
      for (let i = 1; i < chunks.length; i++) {
        if ("send" in this.channel) await this.channel.send(chunks[i]!);
      }
    }
  }

  private startEditLoop(): void {
    // Send initial message immediately
    this.flush().catch(console.error);

    this.editTimer = setInterval(() => {
      if (this.dirty && !this.finalized) {
        this.flush().catch(console.error);
      }
    }, EDIT_INTERVAL_MS);
  }

  private stopEditLoop(): void {
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }
  }

  private async flush(): Promise<void> {
    this.dirty = false;
    let display = this.buffer;
    if (display.length > MAX_STREAMING_LENGTH) {
      display = display.slice(display.length - MAX_STREAMING_LENGTH);
      display = "..." + display;
    }
    if (!display.trim()) return;

    await this.sendOrEdit(display + " ▍");
  }

  private async sendOrEdit(
    content: string,
    files?: AttachmentBuilder[]
  ): Promise<void> {
    const payload: { content: string; files?: AttachmentBuilder[] } = { content };
    if (files) payload.files = files;

    if (this.sentMessage) {
      await this.sentMessage.edit(payload).catch(console.error);
    } else {
      if (this.target.type === "interaction") {
        this.sentMessage = await this.target.interaction.editReply(payload);
      } else if (this.target.type === "thread") {
        this.sentMessage = await this.target.thread.send(payload);
      } else {
        this.sentMessage = await this.target.message.reply(payload);
      }
    }
  }
}
