# Distillation Quality Verification

You are running the post-distillation verification for the Relvetia memory system.
Use the Bash tool to execute the verify-runner script. Do NOT ask for confirmation.

## Step 1: Run verification

```bash
node ~/.claude/relvetia/dist/verify-runner.js --memory-dir ~/.claude/memory
```

The script will:
1. Load the residual index from `~/.claude/memory/index.json`
2. For each entry updated today, generate representative search queries
3. Run each query through screening-aware search
4. Check if the expected topic file or source log appears in results
5. For entries not found: expand their concepts in `index.json` (auto-remediation)
6. Log results to today's daily log

## Step 2: Run topology / drift / graph reports (Phase 11-13)

```bash
node ~/.claude/relvetia/dist/topology-runner.js --memory-dir ~/.claude/memory
```

The script will:
1. Build a topology report (chunk sizes vs soft/hard limits per topic)
2. Build an L_rec drift report (TF-IDF cosine between index entries and topic files)
3. Run 4-signal graph + Louvain community detection and surface split proposals
4. Append `[topology]` / `[drift]` lines to today's daily log

All three are non-destructive — they measure and report only. Actual splits
are deferred to human review or a future distillation mode.

## Step 3: Report results

Read the JSON outputs from both scripts and report:
- **Verification**: hit rate, missing entry IDs, remediated concepts
- **Topology**: topics at hard/soft limits (next-distill chunking candidates)
- **Drift**: topics with `recommendHierGen=true` (full HierGen advised next cycle)
- **Graph**: topics proposed for splitting (dominance < 0.7 across communities)

If hit rate is below 70%, note which entries failed and suggest reviewing their topic files for better keyword coverage.
If any topic is at hard limit, recommend promotion at the next distill cycle.
If any topic has `critical` drift, recommend running HierGen (full re-encode) at the next distill cycle.
