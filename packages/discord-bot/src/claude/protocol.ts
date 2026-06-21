import { EventEmitter } from "events";
import type {
  SDKOutboundMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKStreamEvent,
  SDKControlRequest,
  ContentBlockDelta,
} from "../types.js";

export interface ProtocolEvents {
  init: (msg: SDKSystemMessage) => void;
  text_delta: (text: string) => void;
  tool_use: (toolName: string, input: Record<string, unknown>) => void;
  assistant: (msg: SDKAssistantMessage) => void;
  result: (msg: SDKResultMessage) => void;
  permission_request: (msg: SDKControlRequest) => void;
  error: (err: Error) => void;
}

export class ProtocolRouter extends EventEmitter {
  route(msg: SDKOutboundMessage): void {
    try {
      switch (msg.type) {
        case "system":
          if ("subtype" in msg && msg.subtype === "init") {
            this.emit("init", msg as SDKSystemMessage);
          }
          break;

        case "stream_event":
          this.handleStreamEvent(msg as SDKStreamEvent);
          break;

        case "assistant":
          this.handleAssistant(msg as SDKAssistantMessage);
          break;

        case "result":
          this.emit("result", msg as SDKResultMessage);
          break;

        case "control_request":
          this.handleControlRequest(msg as SDKControlRequest);
          break;

        case "keep_alive":
          break;

        default:
          break;
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleStreamEvent(msg: SDKStreamEvent): void {
    const event = msg.event;
    if (event.type === "content_block_delta") {
      const delta = (event as ContentBlockDelta).delta;
      if (delta.type === "text_delta" && delta.text) {
        this.emit("text_delta", delta.text);
      }
    }
  }

  private handleAssistant(msg: SDKAssistantMessage): void {
    this.emit("assistant", msg);

    for (const block of msg.message.content) {
      if (block.type === "tool_use" && block.name && block.input) {
        this.emit("tool_use", block.name, block.input);
      }
    }
  }

  private handleControlRequest(msg: SDKControlRequest): void {
    if (msg.request.subtype === "can_use_tool") {
      this.emit("permission_request", msg);
    }
  }
}
