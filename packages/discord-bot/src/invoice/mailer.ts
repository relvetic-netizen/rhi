/**
 * Mailgun API を使った請求書メール送信
 * ドメインは MAILGUN_DOMAIN 環境変数で指定
 * 添付ファイル対応（PDF/Excel）
 */
import fs from "fs";
import path from "path";
import { getErrorMessage } from "../logger.js";

const MAILGUN_API_URL = "https://api.mailgun.net/v3";

interface SendInvoiceEmailOptions {
  to: string;
  subject: string;
  body: string;
  attachmentPath: string;
  from?: string;
  cc?: string;
  replyTo?: string;
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendInvoiceEmail(
  options: SendInvoiceEmailOptions
): Promise<SendResult> {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || "mg.example.com";

  if (!apiKey) {
    return { success: false, error: "MAILGUN_API_KEY not set in .env" };
  }

  const senderName = process.env.INVOICE_SENDER_NAME || "Invoice";
  const from = options.from || `${senderName} <invoice@${domain}>`;
  const fileName = path.basename(options.attachmentPath);
  const fileBuffer = fs.readFileSync(options.attachmentPath);

  // Build multipart form data
  const formData = new FormData();
  formData.append("from", from);
  formData.append("to", options.to);
  formData.append("subject", options.subject);
  formData.append("text", options.body);
  if (options.cc) formData.append("cc", options.cc);
  if (options.replyTo) formData.append("h:Reply-To", options.replyTo);
  formData.append(
    "attachment",
    new Blob([fileBuffer]),
    fileName
  );

  const auth = Buffer.from(`api:${apiKey}`).toString("base64");

  try {
    const response = await fetch(`${MAILGUN_API_URL}/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        error: `Mailgun API ${response.status}: ${errText}`,
      };
    }

    const result = (await response.json()) as { id?: string; message?: string };
    return {
      success: true,
      messageId: result.id,
    };
  } catch (err) {
    return {
      success: false,
      error: getErrorMessage(err),
    };
  }
}

/**
 * 請求書送付メールのデフォルトテンプレート
 */
export function buildInvoiceEmailBody(params: {
  clientContactName: string;
  invoiceNumber: string;
  totalAmount: string;
  dueDate: string;
  period?: string;
}): { subject: string; body: string } {
  const senderName = process.env.INVOICE_SENDER_NAME || "Example";
  const senderContact = process.env.INVOICE_SENDER_CONTACT || "担当者";
  const senderEmail = process.env.INVOICE_SENDER_EMAIL || "invoice@example.com";

  const subject = `【${senderName}】請求書送付のご案内 (${params.invoiceNumber})`;

  const body = `${params.clientContactName} 様

いつもお世話になっております。
${senderName}の${senderContact}です。

${params.period ? `${params.period}分の` : ""}請求書を添付にてお送りいたします。

---
請求書番号: ${params.invoiceNumber}
請求金額: ${params.totalAmount}（税込）
お支払期限: ${params.dueDate}
---

ご確認のほど、よろしくお願いいたします。

${senderContact}
${senderName}
${senderEmail}`;

  return { subject, body };
}
