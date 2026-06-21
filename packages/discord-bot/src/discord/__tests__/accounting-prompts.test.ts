import { describe, it, expect, vi, beforeEach } from "vitest";

// notion-ids.json から `accounting` キーが正準であることを前提に固定する
vi.mock("../../config.js", () => ({
  notionDatabaseIds: {
    projects: "mock-projects-db-id",
    tasks: "mock-tasks-db-id",
    accounting: "mock-accounting-db-id",
    counterparties: "mock-counterparties-db-id",
  },
  config: {},
  channelConfigs: {},
}));

import {
  buildInvoicePrompt,
  buildExpensePrompt,
  buildReceivedPrompt,
} from "../commands.js";

const ACCOUNTING_DS = "mock-accounting-db-id";

describe("v3 accounting prompts (種別 filter)", () => {
  describe("buildInvoicePrompt", () => {
    it("emits Accounting DS for 'unpaid' with 種別=invoice_issued filter", () => {
      const p = buildInvoicePrompt("unpaid");
      expect(p).toContain(ACCOUNTING_DS);
      expect(p).toContain("invoice_issued");
      expect(p).toContain("送信済み");
      // 旧 alias の文言が残っていないこと
      expect(p).not.toMatch(/発行請求書DB/);
    });

    it("emits Accounting DS for 'monthly'", () => {
      const p = buildInvoicePrompt("monthly");
      expect(p).toContain(ACCOUNTING_DS);
      expect(p).toContain("invoice_issued");
    });

    it("emits Accounting DS for 'summary'", () => {
      const p = buildInvoicePrompt("summary");
      expect(p).toContain(ACCOUNTING_DS);
      expect(p).toContain("invoice_issued");
    });

    it("falls back to default phrasing for unknown action", () => {
      const p = buildInvoicePrompt("nonsense");
      expect(p).toContain(ACCOUNTING_DS);
      expect(p).toContain("invoice_issued");
    });
  });

  describe("buildExpensePrompt", () => {
    it("emits Accounting DS for 'monthly' with 種別=expense filter", () => {
      const p = buildExpensePrompt("monthly");
      expect(p).toContain(ACCOUNTING_DS);
      expect(p).toContain("expense");
      expect(p).not.toMatch(/経費DB \(/);
    });

    it("emits 種別=expense for 'by_category'", () => {
      const p = buildExpensePrompt("by_category");
      expect(p).toContain("expense");
      expect(p).toContain("カテゴリ別");
    });

    it("emits 種別=expense for 'tax'", () => {
      const p = buildExpensePrompt("tax");
      expect(p).toContain("expense");
      expect(p).toContain("勘定科目");
    });
  });

  describe("buildReceivedPrompt", () => {
    it("emits Accounting DS for 'unpaid' with 種別=invoice_received + ステータス or", () => {
      const p = buildReceivedPrompt("unpaid");
      expect(p).toContain(ACCOUNTING_DS);
      expect(p).toContain("invoice_received");
      expect(p).toContain("未処理");
      expect(p).toContain("承認済み");
      expect(p).not.toMatch(/受領請求書DB \(/);
    });

    it("emits 種別=invoice_received for 'monthly'", () => {
      const p = buildReceivedPrompt("monthly");
      expect(p).toContain("invoice_received");
      expect(p).toContain("受領日=今月");
    });
  });
});
