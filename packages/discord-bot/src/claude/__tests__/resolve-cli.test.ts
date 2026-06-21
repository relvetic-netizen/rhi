import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveClaudeInvocation } from "../resolve-cli.js";

const NODE_BIN = "C:/test/node.exe";

describe("resolveClaudeInvocation", () => {
  let tmp: string;
  let origPath: string | undefined;
  let origCliPath: string | undefined;
  let origCliScript: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "resolve-cli-"));
    origPath = process.env.PATH;
    origCliPath = process.env.CLAUDE_CLI_PATH;
    origCliScript = process.env.CLAUDE_CLI_SCRIPT;
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_CLI_SCRIPT;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env.PATH = origPath;
    if (origCliPath !== undefined) process.env.CLAUDE_CLI_PATH = origCliPath;
    if (origCliScript !== undefined) process.env.CLAUDE_CLI_SCRIPT = origCliScript;
  });

  describe("explicit CLAUDE_CLI_SCRIPT override", () => {
    it("treats .exe path as direct binary", () => {
      const r = resolveClaudeInvocation({
        cliScript: "C:/tools/claude.exe",
        nodeBin: NODE_BIN,
        platformOverride: "win32",
      });
      expect(r).toEqual({ bin: "C:/tools/claude.exe", prefixArgs: [], useShell: false });
    });

    it("treats .cjs path as node + script", () => {
      const r = resolveClaudeInvocation({
        cliScript: "C:/pkg/cli-wrapper.cjs",
        nodeBin: NODE_BIN,
        platformOverride: "win32",
      });
      expect(r).toEqual({
        bin: NODE_BIN,
        prefixArgs: ["C:/pkg/cli-wrapper.cjs"],
        useShell: false,
      });
    });

    it("treats .js path as node + script", () => {
      const r = resolveClaudeInvocation({
        cliScript: "/usr/lib/claude/cli.js",
        nodeBin: "/usr/bin/node",
        platformOverride: "linux",
      });
      expect(r).toEqual({
        bin: "/usr/bin/node",
        prefixArgs: ["/usr/lib/claude/cli.js"],
        useShell: false,
      });
    });

    it("respects override regardless of existence (explicit user intent)", () => {
      const r = resolveClaudeInvocation({
        cliScript: "C:/does/not/exist/claude.exe",
        nodeBin: NODE_BIN,
        platformOverride: "win32",
      });
      expect(r.bin).toBe("C:/does/not/exist/claude.exe");
    });
  });

  describe("Windows .cmd shim parsing", () => {
    it("resolves native claude.exe when shim points to existing bin", () => {
      const pkgDir = join(tmp, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(join(pkgDir, "bin"), { recursive: true });
      const exePath = join(pkgDir, "bin", "claude.exe");
      writeFileSync(exePath, "stub");
      const shimDir = join(tmp, "bin");
      mkdirSync(shimDir, { recursive: true });
      const shim = join(shimDir, "claude.cmd");
      writeFileSync(
        shim,
        `@ECHO off\r\nGOTO start\r\n:start\r\n"${exePath}"   %*\r\n`
      );

      const r = resolveClaudeInvocation({
        cliPath: "claude",
        envPath: shimDir,
        platformOverride: "win32",
        nodeBin: NODE_BIN,
      });
      expect(r).toEqual({ bin: exePath, prefixArgs: [], useShell: false });
    });

    it("falls back to cli-wrapper.cjs when claude.exe is missing (auto-update race)", () => {
      const pkgDir = join(tmp, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(join(pkgDir, "bin"), { recursive: true });
      const exePath = join(pkgDir, "bin", "claude.exe");
      const wrapperPath = join(pkgDir, "cli-wrapper.cjs");
      writeFileSync(wrapperPath, "stub");
      const shimDir = join(tmp, "bin");
      mkdirSync(shimDir, { recursive: true });
      const shim = join(shimDir, "claude.cmd");
      writeFileSync(shim, `"${exePath}"   %*\r\n`);

      const r = resolveClaudeInvocation({
        cliPath: "claude",
        envPath: shimDir,
        platformOverride: "win32",
        nodeBin: NODE_BIN,
      });
      expect(r).toEqual({ bin: NODE_BIN, prefixArgs: [wrapperPath], useShell: false });
    });

    it("falls back to legacy cli.js when neither exe nor wrapper are present", () => {
      const pkgDir = join(tmp, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(join(pkgDir, "bin"), { recursive: true });
      const exePath = join(pkgDir, "bin", "claude.exe");
      const cliPath = join(pkgDir, "cli.js");
      writeFileSync(cliPath, "stub");
      const shimDir = join(tmp, "bin");
      mkdirSync(shimDir, { recursive: true });
      const shim = join(shimDir, "claude.cmd");
      writeFileSync(shim, `"${exePath}"   %*\r\n`);

      const r = resolveClaudeInvocation({
        cliPath: "claude",
        envPath: shimDir,
        platformOverride: "win32",
        nodeBin: NODE_BIN,
      });
      expect(r).toEqual({ bin: NODE_BIN, prefixArgs: [cliPath], useShell: false });
    });

    // Windows-only: shim content contains literal "\" path separators which cannot
    // be resolved by existsSync() on Linux/macOS file systems (POSIX treats "\" as
    // a literal character, not a separator). The first 3 tests in this block use
    // path.join() so they work cross-platform; only this test hardcodes Windows
    // separators in the shim payload to mimic real npm-cmd-shim output.
    it.skipIf(process.platform !== "win32")("expands %dp0% relative paths (real npm-cmd-shim syntax)", () => {
      const shimDir = join(tmp, "bin");
      mkdirSync(shimDir, { recursive: true });
      const pkgDir = join(shimDir, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(join(pkgDir, "bin"), { recursive: true });
      const exePath = join(pkgDir, "bin", "claude.exe");
      writeFileSync(exePath, "stub");
      const shim = join(shimDir, "claude.cmd");
      writeFileSync(
        shim,
        `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`
      );

      const r = resolveClaudeInvocation({
        cliPath: "claude",
        envPath: shimDir,
        platformOverride: "win32",
        nodeBin: NODE_BIN,
      });
      expect(r.bin).toMatch(/claude\.exe$/);
      expect(r.prefixArgs).toEqual([]);
      expect(r.useShell).toBe(false);
    });
  });

  describe("fall-through behavior", () => {
    it("returns bare bin with useShell=true on Windows when no shim found", () => {
      const r = resolveClaudeInvocation({
        cliPath: "claude",
        envPath: join(tmp, "empty"),
        platformOverride: "win32",
        nodeBin: NODE_BIN,
      });
      expect(r).toEqual({ bin: "claude", prefixArgs: [], useShell: true });
    });

    it("returns bare bin without shell on POSIX", () => {
      const r = resolveClaudeInvocation({
        cliPath: "claude",
        platformOverride: "linux",
        nodeBin: "/usr/bin/node",
      });
      expect(r).toEqual({ bin: "claude", prefixArgs: [], useShell: false });
    });

    it("normalizes backslashes when falling through on Windows", () => {
      const r = resolveClaudeInvocation({
        cliPath: "C:\\tools\\claude",
        envPath: "",
        platformOverride: "win32",
        nodeBin: NODE_BIN,
      });
      expect(r.bin).toBe("C:/tools/claude");
      expect(r.useShell).toBe(true);
    });
  });
});
