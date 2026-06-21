import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import { NDJSONParser } from "../ndjson.js";

function createReadable(lines: string[]): Readable {
  const stream = new Readable({ read() {} });
  for (const line of lines) {
    stream.push(line + "\n");
  }
  stream.push(null);
  return stream;
}

describe("NDJSONParser", () => {
  it("parses valid JSON lines", async () => {
    const messages: unknown[] = [];
    const stream = createReadable([
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    ]);

    const parser = new NDJSONParser(stream);
    parser.onMessage((msg) => messages.push(msg));

    // Wait for stream to finish
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(2);
    expect((messages[0] as any).type).toBe("system");
    expect((messages[1] as any).type).toBe("assistant");
    parser.close();
  });

  it("ignores empty lines", async () => {
    const messages: unknown[] = [];
    const stream = createReadable([
      "",
      JSON.stringify({ type: "test" }),
      "  ",
    ]);

    const parser = new NDJSONParser(stream);
    parser.onMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(1);
    parser.close();
  });

  it("handles invalid JSON gracefully", async () => {
    const messages: unknown[] = [];
    const stream = createReadable([
      "not json",
      JSON.stringify({ type: "valid" }),
    ]);

    const parser = new NDJSONParser(stream);
    parser.onMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 50));

    // Invalid line should be skipped, valid line should be parsed
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).type).toBe("valid");
    parser.close();
  });
});
