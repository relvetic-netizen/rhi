/**
 * CLI script for generating invoices.
 *
 * Usage:
 *   node dist/scripts/generate-invoice.js '<JSON data>'
 *   node dist/scripts/generate-invoice.js --fumoar '<JSON data>'
 *
 * Standard format (PDF):
 * {
 *   "invoiceNumber": "INV-2026-001",
 *   "issueDate": "2026/04/03",
 *   "dueDate": "2026/04/30",
 *   "client": { "name": "Example Client Inc." },
 *   "lineItems": [
 *     { "description": "動画編集 4月分", "quantity": 1, "unit": "式", "unitPrice": 50000, "amount": 50000 }
 *   ],
 *   "applyWithholding": true,
 *   "notes": "備考テキスト"
 * }
 *
 * Fumoar format (Excel):
 * {
 *   "invoiceNumber": 1,
 *   "issueDate": "2026/04/03",
 *   "subject": "〇〇様 動画編集",
 *   "dueDate": "2026/04/30",
 *   "lineItems": [
 *     { "description": "動画編集", "quantity": 1, "unit": "式", "unitPrice": 50000, "taxRate": 0.1, "amount": 50000 }
 *   ]
 * }
 *
 * Output: file path of the generated file
 */

import { generateInvoicePDF } from "../invoice/generator.js";
import { generateFumoarInvoice } from "../invoice/fumoar-generator.js";

async function main() {
  const args = process.argv.slice(2);
  const isFumoar = args[0] === "--fumoar";
  let jsonStr = isFumoar ? args[1] : args[0];

  if (!jsonStr) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    jsonStr = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!jsonStr) {
    console.error("Usage: generate-invoice [--fumoar] '<JSON>'");
    process.exit(1);
  }

  const data = JSON.parse(jsonStr);

  if (isFumoar) {
    const xlsxPath = generateFumoarInvoice(data);
    console.log(xlsxPath);
  } else {
    const pdfPath = await generateInvoicePDF(data);
    console.log(pdfPath);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
