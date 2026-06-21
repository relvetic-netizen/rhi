import puppeteer from "puppeteer-core";
import { renderInvoiceHTML } from "./template.js";
import type { InvoiceData } from "./types.js";
import { config, invoiceDefaults } from "../config.js";
import path from "path";
import fs from "fs";

export async function generateInvoicePDF(
  data: Partial<InvoiceData> & {
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    client: InvoiceData["client"];
    lineItems: InvoiceData["lineItems"];
  },
): Promise<string> {
  // Calculate amounts
  const subtotal = data.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const taxRate = data.taxRate ?? 0.1;
  const taxAmount = data.taxAmount ?? Math.floor(subtotal * taxRate);
  const total = subtotal + taxAmount;

  const withholdingData = data.withholding;

  const netAmount = data.netAmount ?? total - (withholdingData?.amount ?? 0);

  const fullData: InvoiceData = {
    invoiceNumber: data.invoiceNumber,
    issueDate: data.issueDate,
    dueDate: data.dueDate,
    client: data.client,
    issuer: data.issuer ??
      invoiceDefaults.issuer ?? {
        name: "",
        representative: "",
        postalCode: "",
        address: "",
        phone: "",
        email: "",
      },
    lineItems: data.lineItems,
    subtotal,
    taxRate,
    taxAmount,
    total,
    withholding: withholdingData,
    netAmount,
    bankInfo: data.bankInfo ??
      invoiceDefaults.bankInfo ?? {
        bankName: "",
        branchName: "",
        branchCode: "",
        accountType: "",
        accountNumber: "",
        accountHolder: "",
      },
    notes: data.notes,
  };

  const html = renderInvoiceHTML(fullData);

  // Ensure output directory exists
  if (!config.invoiceOutputDir)
    throw new Error("INVOICE_OUTPUT_DIR not configured");
  const year = data.issueDate.split("/")[0];
  const outDir = path.join(config.invoiceOutputDir, year);
  fs.mkdirSync(outDir, { recursive: true });

  const fileName = `${data.issueDate.replace(/\//g, "")}_${data.client.name}_${data.invoiceNumber}.pdf`;
  const outPath = path.join(outDir, fileName);

  // Generate PDF
  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: config.chromeNoSandbox
      ? ["--no-sandbox", "--disable-setuid-sandbox"]
      : [],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", right: "20mm", bottom: "15mm", left: "20mm" },
    });
  } finally {
    await browser.close();
  }

  return outPath;
}
