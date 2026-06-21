/**
 * CLI script for sending invoice emails via Mailgun.
 *
 * Usage:
 *   node dist/scripts/send-invoice-email.js '<JSON>'
 *
 * JSON format:
 * {
 *   "to": "client@example.com",
 *   "attachmentPath": "path/to/invoice.pdf",
 *   "clientContactName": "Example Client Inc.",
 *   "invoiceNumber": "INV-2026-001",
 *   "totalAmount": "¥49,895",
 *   "dueDate": "2026/04/30",
 *   "period": "4月"
 * }
 *
 * Or with custom subject/body:
 * {
 *   "to": "client@example.com",
 *   "attachmentPath": "path/to/file.xlsx",
 *   "subject": "カスタム件名",
 *   "body": "カスタム本文"
 * }
 *
 * Output: JSON result { success, messageId? }
 */

import "dotenv/config";
import {
  sendInvoiceEmail,
  buildInvoiceEmailBody,
} from "../invoice/mailer.js";

// DNS fix for IPv6 timeout
import "../dns-fix.js";

async function main() {
  const jsonStr = process.argv[2];
  if (!jsonStr) {
    console.error(
      "Usage: send-invoice-email '<JSON>'"
    );
    process.exit(1);
  }

  const data = JSON.parse(jsonStr);

  let subject: string;
  let body: string;

  if (data.subject && data.body) {
    subject = data.subject;
    body = data.body;
  } else {
    const template = buildInvoiceEmailBody({
      clientContactName: data.clientContactName,
      invoiceNumber: data.invoiceNumber,
      totalAmount: data.totalAmount,
      dueDate: data.dueDate,
      period: data.period,
    });
    subject = template.subject;
    body = template.body;
  }

  const result = await sendInvoiceEmail({
    to: data.to,
    subject,
    body,
    attachmentPath: data.attachmentPath,
    cc: data.cc,
    replyTo: data.replyTo || process.env.INVOICE_SENDER_EMAIL || "invoice@example.com",
  });

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
