import type { InvoiceData } from "./types.js";

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

function formatDate(dateStr: string): string {
  return dateStr; // Already YYYY/MM/DD
}

function renderLineItems(data: InvoiceData): string {
  return data.lineItems
    .map(
      (item) => `
      <tr>
        <td class="item-desc">${item.description}</td>
        <td class="center">${item.quantity}</td>
        <td class="center">${item.unit}</td>
        <td class="right">${formatYen(item.unitPrice)}</td>
        <td class="right">${formatYen(item.amount)}</td>
      </tr>`
    )
    .join("");
}

function renderWithholding(data: InvoiceData): string {
  if (!data.withholding) return "";
  return `
    <tr>
      <td colspan="3"></td>
      <td class="label">源泉徴収税（${(data.withholding.rate * 100).toFixed(2)}%）</td>
      <td class="right bold">-${formatYen(data.withholding.amount)}</td>
    </tr>`;
}

function renderRegistration(data: InvoiceData): string {
  if (!data.issuer.registrationNumber) return "";
  return `<p class="registration">登録番号: ${data.issuer.registrationNumber}</p>`;
}

export function renderInvoiceHTML(data: InvoiceData): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 15mm 20mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif;
    font-size: 10pt;
    color: #333;
    line-height: 1.6;
  }
  .container { width: 100%; max-width: 210mm; margin: 0 auto; }

  /* Header */
  .header { text-align: center; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 3px solid #2c3e50; }
  .header h1 { font-size: 22pt; letter-spacing: 8px; color: #2c3e50; }
  .header-meta { display: flex; justify-content: space-between; margin-top: 8px; font-size: 9pt; color: #666; }

  /* Two-column layout */
  .parties { display: flex; justify-content: space-between; margin: 20px 0; }
  .party { width: 48%; }

  /* Client (left) */
  .client-name { font-size: 14pt; font-weight: bold; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 8px; }
  .honorific { font-size: 11pt; font-weight: normal; }

  /* Issuer (right) */
  .issuer { text-align: right; font-size: 9pt; }
  .issuer .name { font-size: 12pt; font-weight: bold; margin-bottom: 4px; }
  .issuer .registration { font-size: 8.5pt; color: #555; margin-top: 2px; }

  /* Total box */
  .total-box {
    background: #f8f9fa;
    border: 2px solid #2c3e50;
    border-radius: 4px;
    padding: 12px 20px;
    margin: 15px 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .total-box .label { font-size: 11pt; }
  .total-box .amount { font-size: 18pt; font-weight: bold; color: #2c3e50; }

  /* Items table */
  table { width: 100%; border-collapse: collapse; margin: 15px 0; }
  th {
    background: #2c3e50;
    color: white;
    padding: 8px 10px;
    font-size: 9pt;
    text-align: center;
  }
  td { padding: 7px 10px; border-bottom: 1px solid #ddd; font-size: 9.5pt; }
  .item-desc { width: 45%; }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: bold; }
  .label { text-align: right; font-weight: bold; color: #555; }

  /* Totals section */
  .totals-section { margin-top: 5px; }
  .totals-section tr td { border-bottom: none; padding: 4px 10px; }
  .totals-section .grand-total td {
    border-top: 2px solid #2c3e50;
    padding-top: 8px;
    font-size: 11pt;
  }

  /* Footer */
  .footer { margin-top: 25px; }
  .section-title {
    font-size: 10pt;
    font-weight: bold;
    color: #2c3e50;
    border-left: 3px solid #2c3e50;
    padding-left: 8px;
    margin-bottom: 6px;
  }
  .bank-info {
    background: #f8f9fa;
    padding: 10px 15px;
    border-radius: 4px;
    font-size: 9.5pt;
    margin-bottom: 15px;
  }
  .bank-info table { margin: 0; }
  .bank-info td { border: none; padding: 2px 8px; }
  .bank-info .bank-label { width: 80px; color: #666; }

  .notes { font-size: 9pt; color: #666; margin-top: 10px; padding: 10px; border: 1px dashed #ccc; border-radius: 4px; }
</style>
</head>
<body>
<div class="container">
  <!-- Header -->
  <div class="header">
    <h1>請 求 書</h1>
    <div class="header-meta">
      <span>No. ${data.invoiceNumber}</span>
      <span>発行日: ${formatDate(data.issueDate)}</span>
    </div>
  </div>

  <!-- Parties -->
  <div class="parties">
    <div class="party">
      <div class="client-name">
        ${data.client.name} <span class="honorific">${data.client.honorific || "御中"}</span>
      </div>
      <p style="font-size:9pt; color:#666;">下記の通りご請求申し上げます。</p>
    </div>
    <div class="party issuer">
      <p class="name">${data.issuer.name}</p>
      <p>${data.issuer.representative}</p>
      <p>〒${data.issuer.postalCode}</p>
      <p>${data.issuer.address}</p>
      <p>TEL: ${data.issuer.phone}</p>
      <p>E-Mail: ${data.issuer.email}</p>
      ${renderRegistration(data)}
    </div>
  </div>

  <!-- Total box -->
  <div class="total-box">
    <span class="label">ご請求金額（税込）</span>
    <span class="amount">${formatYen(data.netAmount)}</span>
  </div>

  <!-- Due date -->
  <p style="text-align:right; font-size:9.5pt; margin-bottom:10px;">
    <strong>お支払期限:</strong> ${formatDate(data.dueDate)}
  </p>

  <!-- Line items -->
  <table>
    <thead>
      <tr>
        <th>品名・摘要</th>
        <th style="width:60px;">数量</th>
        <th style="width:50px;">単位</th>
        <th style="width:100px;">単価</th>
        <th style="width:110px;">金額</th>
      </tr>
    </thead>
    <tbody>
      ${renderLineItems(data)}
    </tbody>
  </table>

  <!-- Totals -->
  <table class="totals-section">
    <tr>
      <td colspan="3"></td>
      <td class="label">小計</td>
      <td class="right">${formatYen(data.subtotal)}</td>
    </tr>
    <tr>
      <td colspan="3"></td>
      <td class="label">消費税（${(data.taxRate * 100).toFixed(0)}%）</td>
      <td class="right">${formatYen(data.taxAmount)}</td>
    </tr>
    <tr>
      <td colspan="3"></td>
      <td class="label">税込合計</td>
      <td class="right bold">${formatYen(data.total)}</td>
    </tr>
    ${renderWithholding(data)}
    <tr class="grand-total">
      <td colspan="3"></td>
      <td class="label">ご請求金額</td>
      <td class="right bold">${formatYen(data.netAmount)}</td>
    </tr>
  </table>

  <!-- Bank info -->
  <div class="footer">
    <p class="section-title">お振込先</p>
    <div class="bank-info">
      <table>
        <tr><td class="bank-label">金融機関</td><td>${data.bankInfo.bankName}</td></tr>
        <tr><td class="bank-label">支店名</td><td>${data.bankInfo.branchName}（${data.bankInfo.branchCode}）</td></tr>
        <tr><td class="bank-label">口座種別</td><td>${data.bankInfo.accountType}</td></tr>
        <tr><td class="bank-label">口座番号</td><td>${data.bankInfo.accountNumber}</td></tr>
        <tr><td class="bank-label">口座名義</td><td>${data.bankInfo.accountHolder}</td></tr>
      </table>
    </div>

    ${data.notes ? `<div class="notes"><strong>備考:</strong> ${data.notes}</div>` : ""}
  </div>
</div>
</body>
</html>`;
}
