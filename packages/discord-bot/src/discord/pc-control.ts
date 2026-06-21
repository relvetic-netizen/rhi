import {
  type ChatInputCommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import { execFile } from "child_process";
import { getErrorMessage } from "../logger.js";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import type { SessionManager } from "../session/manager.js";
import { handleTurn } from "./handlers.js";

const execFileAsync = promisify(execFile);
const SCREENSHOT_PATH = path.join(os.tmpdir(), "discord-pc-screenshot.png");

const SCREENSHOT_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${SCREENSHOT_PATH.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`.trim();

export async function handlePc(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager
): Promise<void> {
  const action = interaction.options.getString("action", true);

  if (action === "screenshot" || action === "ss" || action === "スクショ") {
    await handleScreenshot(interaction);
  } else {
    await handlePcCommand(interaction, sessionManager, action);
  }
}

async function handleScreenshot(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply();

  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", SCREENSHOT_PS], {
      timeout: 10000,
    });

    if (!fs.existsSync(SCREENSHOT_PATH)) {
      await interaction.editReply("スクリーンショットの取得に失敗しました。");
      return;
    }

    const file = new AttachmentBuilder(SCREENSHOT_PATH, {
      name: `screenshot-${Date.now()}.png`,
    });

    await interaction.editReply({
      content: "📸 現在のデスクトップ",
      files: [file],
    });
  } catch (err) {
    const msg = getErrorMessage(err);
    await interaction.editReply(`スクリーンショット失敗: ${msg}`);
  }
}

async function handlePcCommand(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
  action: string
): Promise<void> {
  const prompt = `あなたはPCの遠隔操作・ブラウザ操作アシスタントです。以下のブラウザツールを使って操作を実行してください。

利用可能なツール:
- browser_open(url): URLを開いてページ構造を取得
- browser_snapshot(): 現在のページのアクセシビリティツリーを取得（要素の@refを確認）
- browser_click(@ref): 要素をクリック
- browser_fill(@ref, text): 入力フィールドにテキスト入力
- browser_type(text): キーボード入力
- browser_screenshot(): スクリーンショット撮影
- browser_scroll(direction): ページスクロール（up/down）
- browser_navigate(action): 戻る/進む/リロード
- browser_get_text(@ref): 要素のテキストを取得
- browser_eval(script): JavaScript実行

操作指示: ${action}

手順:
1. 必要に応じてbrowser_openでURLを開く
2. browser_snapshotで要素の@refを確認
3. 指示された操作を実行
4. browser_screenshotで結果を確認
5. 結果を日本語で報告

session_nameパラメータを使ってセッションを維持してください（ログイン状態の保持に必要）。`;

  await interaction.deferReply();
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id
  );
  await handleTurn(session, prompt, { type: "interaction", interaction });
}
