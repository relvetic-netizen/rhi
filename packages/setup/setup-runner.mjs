import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--profile" && argv[i + 1]) args.profile = argv[++i];
    if (argv[i] === "--memory-dir" && argv[i + 1]) args.memoryDir = argv[++i];
  }
  return args;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw);
}

async function writeJson(p, data) {
  await writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function createMemoryStructure(memoryDir) {
  const created = [];

  await mkdir(memoryDir, { recursive: true });
  for (const sub of ["logs", "topics"]) {
    const dir = join(memoryDir, sub);
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
      created.push(sub + "/");
    }
  }

  const memoryMd = join(memoryDir, "MEMORY.md");
  if (!(await exists(memoryMd))) {
    await writeFile(memoryMd, "# Memory Index\n", "utf8");
    created.push("MEMORY.md");
  }

  return created;
}

function buildConfig(profile, memoryDir) {
  const isFull = profile === "full";
  return {
    version: 1,
    profile,
    distillation: {
      mode: isFull ? "daemon" : "session-hook",
      cooldownHours: 8,
      model: "claude-sonnet-4-6",
      maxTurns: 40,
      distillMode: isFull ? "full" : "standard",
    },
    memory: {
      dir: memoryDir,
    },
    search: {
      enabled: true,
    },
    crossMachine: {
      enabled: isFull,
      peers: [],
    },
  };
}

async function writeConfig(configPath, profile, memoryDir) {
  const newConfig = buildConfig(profile, memoryDir);

  if (await exists(configPath)) {
    const existing = await readJson(configPath);
    const merged = { ...existing, ...newConfig };
    merged.memory = { ...newConfig.memory };
    if (existing.crossMachine?.peers?.length) {
      merged.crossMachine.peers = existing.crossMachine.peers;
    }
    await writeJson(configPath, merged);
  } else {
    await mkdir(dirname(configPath), { recursive: true });
    await writeJson(configPath, newConfig);
  }
}

async function registerHook(profile) {
  if (profile === "full") return false;

  const settingsPath = join(homedir(), ".claude", "settings.json");

  const distillCmd = `node "${join(__dirname, "distill-trigger.mjs")}"`;

  if (!(await exists(settingsPath))) {
    await mkdir(join(homedir(), ".claude"), { recursive: true });
    const hookEntry = { type: "command", command: distillCmd, timeout: 10000 };
    const newSettings = { hooks: { SessionStart: [{ matcher: "", hooks: [hookEntry] }] } };
    await writeJson(settingsPath, newSettings);
    return true;
  }

  const settings = await readJson(settingsPath);

  const normalize = (s) => {
    const slashed = s.replace(/\\/g, "/");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };

  const sessionStart = settings.hooks?.SessionStart;
  if (sessionStart) {
    for (const group of sessionStart) {
      const hookList = group.hooks || [];
      if (hookList.some((h) => normalize(h.command) === normalize(distillCmd))) return false;
    }
  }

  const now = new Date();
  const dateSuffix =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  await copyFile(settingsPath, settingsPath + ".bak-" + dateSuffix);

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

  const hookEntry = { type: "command", command: distillCmd, timeout: 10000 };

  const defaultGroup = settings.hooks.SessionStart.find((g) => g.matcher === "");
  if (defaultGroup) {
    defaultGroup.hooks.push(hookEntry);
  } else {
    settings.hooks.SessionStart.push({ matcher: "", hooks: [hookEntry] });
  }

  await writeJson(settingsPath, settings);
  return true;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.profile || !args.memoryDir) {
    const err = { success: false, error: "Missing required args: --profile and --memory-dir" };
    console.log(JSON.stringify(err));
    process.exit(1);
  }

  if (!["standard", "full"].includes(args.profile)) {
    const err = { success: false, error: `Invalid profile: ${args.profile}` };
    console.log(JSON.stringify(err));
    process.exit(1);
  }

  if (!isAbsolute(args.memoryDir)) {
    console.log(JSON.stringify({ success: false, error: "memory-dir must be an absolute path" }));
    process.exit(1);
  }

  try {
    const existingMemory = await exists(args.memoryDir);
    const created = await createMemoryStructure(args.memoryDir);
    const configPath = join(homedir(), ".claude", "rhi", "config.json");
    await writeConfig(configPath, args.profile, args.memoryDir);
    const hookRegistered = await registerHook(args.profile);

    const result = {
      success: true,
      profile: args.profile,
      memoryDir: args.memoryDir,
      configPath,
      created,
      hookRegistered,
      existingMemoryDetected: existingMemory,
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    const err = { success: false, error: e.message };
    console.log(JSON.stringify(err));
    process.exit(1);
  }
}

main();
