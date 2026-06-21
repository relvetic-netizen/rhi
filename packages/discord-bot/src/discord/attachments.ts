import fs from "fs";
import path from "path";
import os from "os";
import type { Attachment, Collection, Snowflake } from "discord.js";

const TEMP_DIR = path.join(os.tmpdir(), "discord-claude-bot-attachments");
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Download image attachments from a Discord message to temp files.
 * Returns file paths that Claude Code can read via the Read tool.
 */
export async function downloadAttachments(
  attachments: Collection<Snowflake, Attachment>
): Promise<string[]> {
  const images = attachments.filter(
    (a) => IMAGE_TYPES.has(a.contentType ?? "") && a.size <= MAX_FILE_SIZE
  );

  if (images.size === 0) return [];

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const paths: string[] = [];
  for (const [, att] of images) {
    try {
      const ext = att.name?.split(".").pop() || "png";
      const filename = `${att.id}.${ext}`;
      const filePath = path.join(TEMP_DIR, filename);

      const res = await fetch(att.url);
      if (!res.ok) continue;

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      console.error(`[attachments] Failed to download ${att.name}:`, err);
    }
  }

  return paths;
}

export function cleanupTempAttachments(maxAgeMs = 3_600_000): void {
  if (!fs.existsSync(TEMP_DIR)) return;
  const files = fs.readdirSync(TEMP_DIR);
  const now = Date.now();
  for (const file of files) {
    try {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}

export function buildImagePrompt(imagePaths: string[]): string {
  if (imagePaths.length === 0) return "";
  const files = imagePaths.map((p) => p.replace(/\\/g, "/")).join("\n");
  return `[添付画像あり — Readツールで読み取ってください]\n${files}\n\n`;
}
