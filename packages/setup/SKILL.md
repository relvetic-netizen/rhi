Interactive setup for the RHI persistent memory system. Detects environment, asks 3 questions, and configures memory + distillation.

## Step 1: Environment Detection

Run these checks silently (do not show raw output to the user):

```bash
node -e "const os=require('os'),fs=require('fs'),p=require('path'),h=os.homedir();console.log('OS='+process.platform);console.log('NODE='+process.version);console.log('EXISTING_MEMORY='+fs.existsSync(p.join(h,'.claude','memory')));console.log('EXISTING_CONFIG='+fs.existsSync(p.join(h,'.claude','rhi','config.json')))"
```

If EXISTING_MEMORY=true, note this — existing memory data will be preserved.

## Step 2: Questions

**If re-running** (EXISTING_CONFIG=true): read `~/.claude/rhi/config.json`, show the current profile and settings in a short summary, and ask what the user wants to change. Then skip to Step 4 with the updated answers.

**If first run**, ask these 3 questions one at a time. Wait for each answer before asking the next.

1. "この PC は基本つけっぱなし？ それとも使う時だけ電源入れる？" — choices: つけっぱなし / 使う時だけ
2. "他の PC と連携させたい？" — choices: しない / する
3. "memory の保存先はデフォルト (~/.claude/memory) でいい？" — choices: デフォルトでいい / 変えたい (if 変えたい, ask for absolute path)

## Step 3: Determine Profile

- Q1=つけっぱなし AND Q2=する → **Full**
- All other combinations → **Standard**

## Step 4: Confirm

Show a summary table:

| 項目 | 値 |
|------|-----|
| プロファイル | Standard or Full |
| memory 保存先 | (absolute path) |
| 蒸留モード | session-hook or daemon |
| 他 PC 連携 | する / しない |

Ask the user to confirm before proceeding.

## Step 5: Execute

Resolve the absolute path to this package's setup-runner.mjs. It lives next to this SKILL.md file. Run:

```bash
node <absolute-path-to-setup-runner.mjs> --profile <standard|full> --memory-dir <absolute-path>
```

The memory-dir must be an absolute path (expand `~` to the actual home directory).

## Step 6: Report Results

The script outputs JSON to stdout. Parse it and report to the user:

- What was created (directories, files)
- Whether the hook was registered
- Whether existing memory was detected and preserved

If the profile is **Full**, additionally tell the user:
- Daemon-based distillation is configured, but PM2 must be set up separately
- Point them to `packages/daemon/` in the rhi for daemon setup instructions
