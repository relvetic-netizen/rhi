/**
 * フーモア専用請求書生成
 * フーモア指定のExcelテンプレートを使って請求書を作成する。
 */
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { config } from "../config.js";

export interface FumoarInvoiceData {
  invoiceNumber: number; // No. (sequential)
  issueDate: string; // YYYY/MM/DD
  subject: string; // 件名
  dueDate: string; // YYYY/MM/DD
  lineItems: Array<{
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    taxRate: number; // 0.1 or 0.08 or 0
    amount: number;
  }>;
  notes?: string;
}

function dateToSerial(dateStr: string): number {
  // Excel serial date: days since 1900-01-01 (with the 1900 leap year bug)
  const [y, m, d] = dateStr.split("/").map(Number);
  const date = new Date(y, m - 1, d);
  const epoch = new Date(1899, 11, 30); // Excel epoch
  return Math.round((date.getTime() - epoch.getTime()) / 86400000);
}

export function generateFumoarInvoice(data: FumoarInvoiceData): string {
  if (!config.fumoarTemplatePath) {
    throw new Error("FUMOAR_TEMPLATE_PATH not configured");
  }
  const wb = XLSX.readFile(config.fumoarTemplatePath);
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Invoice number
  ws["H2"] = { t: "n", v: data.invoiceNumber };

  // Issue date
  ws["H3"] = { t: "n", v: dateToSerial(data.issueDate), z: 'yyyy"年"m"月"d"日"' };

  // Subject
  ws["B6"] = { t: "s", v: data.subject };

  // Due date
  ws["B7"] = { t: "n", v: dateToSerial(data.dueDate), z: 'yyyy"年"m"月"d"日"' };

  // Line items (rows 14-28, i.e. row index 14-28 in 0-based = Excel rows 15-29)
  const MAX_ITEMS = 15;
  const ITEM_START_ROW = 14; // 0-based row index (Excel row 15)

  for (let i = 0; i < MAX_ITEMS; i++) {
    const row = ITEM_START_ROW + i;
    const r = row + 1; // 1-based for cell addresses

    if (i < data.lineItems.length) {
      const item = data.lineItems[i];
      ws[`A${r}`] = { t: "s", v: item.description };
      ws[`D${r}`] = { t: "n", v: item.quantity };
      ws[`E${r}`] = { t: "s", v: item.unit };
      ws[`F${r}`] = { t: "n", v: item.unitPrice };
      ws[`G${r}`] = { t: "n", v: item.taxRate, z: "0%" };
      ws[`H${r}`] = { t: "n", v: item.amount };
    } else {
      // Clear unused rows
      delete ws[`A${r}`];
      delete ws[`D${r}`];
      delete ws[`E${r}`];
      delete ws[`F${r}`];
      ws[`G${r}`] = { t: "n", v: 0, z: "0%" };
      ws[`H${r}`] = { t: "s", v: "" };
    }
  }

  // Calculate totals
  const subtotal = data.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax10Items = data.lineItems.filter((i) => i.taxRate === 0.1);
  const tax8Items = data.lineItems.filter((i) => i.taxRate === 0.08);
  const tax0Items = data.lineItems.filter((i) => i.taxRate === 0);

  const subtotal10 = tax10Items.reduce((s, i) => s + i.amount, 0);
  const subtotal8 = tax8Items.reduce((s, i) => s + i.amount, 0);
  const subtotal0 = tax0Items.reduce((s, i) => s + i.amount, 0);

  const tax10 = Math.floor(subtotal10 * 0.1);
  const tax8 = Math.floor(subtotal8 * 0.08);
  const totalTax = tax10 + tax8;
  const total = subtotal + totalTax;

  // Subtotal / Tax / Total
  ws["H30"] = { t: "n", v: subtotal };
  ws["H31"] = { t: "n", v: totalTax };
  ws["H32"] = { t: "n", v: total };
  ws["B11"] = { t: "n", v: total };

  // Tax breakdown
  ws["B32"] = { t: "n", v: subtotal10 };
  ws["C32"] = { t: "n", v: tax10 };
  ws["B33"] = { t: "n", v: subtotal8 };
  ws["C33"] = { t: "n", v: tax8 };
  ws["B34"] = { t: "n", v: subtotal0 };
  ws["C34"] = { t: "n", v: 0 };

  // Notes
  if (data.notes) {
    ws["A36"] = { t: "s", v: `備考: ${data.notes}` };
  }

  // Save
  if (!config.invoiceOutputDir) {
    throw new Error("INVOICE_OUTPUT_DIR not configured");
  }
  const year = data.issueDate.split("/")[0];
  const outDir = path.join(config.invoiceOutputDir, year);
  fs.mkdirSync(outDir, { recursive: true });

  const dateStr = data.issueDate.replace(/\//g, "");
  const fileName = `${dateStr}_フーモア_${data.subject.slice(0, 30)}.xlsx`;
  const outPath = path.join(outDir, fileName);

  XLSX.writeFile(wb, outPath);
  return outPath;
}
