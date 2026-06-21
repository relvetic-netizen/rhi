import { createInterface } from "readline";
import type { Readable, Writable } from "stream";
import type { SDKOutboundMessage } from "../types.js";

export class NDJSONParser {
  private rl: ReturnType<typeof createInterface>;
  private listeners: Array<(msg: SDKOutboundMessage) => void> = [];

  constructor(stream: Readable) {
    this.rl = createInterface({ input: stream, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as SDKOutboundMessage;
        for (const listener of this.listeners) {
          listener(msg);
        }
      } catch (err) {
        console.error("[ndjson] Failed to parse line:", line.slice(0, 200), err);
      }
    });
  }

  onMessage(listener: (msg: SDKOutboundMessage) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    this.rl.close();
    this.listeners = [];
  }
}

export class NDJSONWriter {
  private stream: Writable;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  async write(msg: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      const canContinue = this.stream.write(line, "utf-8", (err) => {
        if (err) reject(err);
      });
      if (canContinue) {
        resolve();
      } else {
        this.stream.once("drain", resolve);
      }
    });
  }

  close(): void {
    this.stream.end();
  }
}
