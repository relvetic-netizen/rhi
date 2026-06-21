import { AttachmentBuilder } from "discord.js";

const MAX_MSG_LENGTH = 1950;
const FILE_THRESHOLD = 8000;

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = MAX_MSG_LENGTH;
    const segment = remaining.slice(0, MAX_MSG_LENGTH);

    // Track code block state in this segment
    const fences = [...segment.matchAll(/```(\w*)?/g)];
    let localInCodeBlock = inCodeBlock;
    let localLang = codeBlockLang;
    for (const fence of fences) {
      if (localInCodeBlock) {
        localInCodeBlock = false;
      } else {
        localInCodeBlock = true;
        localLang = fence[1] || "";
      }
    }

    // Find best split point (prefer paragraph, then line, then space)
    const paragraphBreak = segment.lastIndexOf("\n\n");
    const lineBreak = segment.lastIndexOf("\n");
    const spaceBreak = segment.lastIndexOf(" ");

    if (paragraphBreak > MAX_MSG_LENGTH * 0.3) {
      splitAt = paragraphBreak;
    } else if (lineBreak > MAX_MSG_LENGTH * 0.3) {
      splitAt = lineBreak;
    } else if (spaceBreak > MAX_MSG_LENGTH * 0.3) {
      splitAt = spaceBreak;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).trimStart();

    // Handle code block continuity
    const chunkFences = [...chunk.matchAll(/```(\w*)?/g)];
    let chunkInCode = inCodeBlock;
    let chunkLang = codeBlockLang;
    for (const fence of chunkFences) {
      if (chunkInCode) {
        chunkInCode = false;
      } else {
        chunkInCode = true;
        chunkLang = fence[1] || "";
      }
    }

    if (chunkInCode) {
      chunk += "\n```";
      remaining = `\`\`\`${chunkLang}\n` + remaining;
      inCodeBlock = true;
      codeBlockLang = chunkLang;
    } else {
      inCodeBlock = false;
      codeBlockLang = "";
    }

    chunks.push(chunk);
  }

  return chunks;
}

export function shouldAttachAsFile(text: string): boolean {
  return text.length > FILE_THRESHOLD;
}

export function createFileAttachment(
  text: string,
  filename = "response.md"
): AttachmentBuilder {
  return new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: filename,
  });
}
