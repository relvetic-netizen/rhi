# Relvetia Eval Optimization — Weekly Hill-Climb

Run the eval-based hill-climb optimization to find better screening thresholds.

## Step 1: Run optimization

```bash
node ~/.claude/relvetia/dist/eval-runner.js --optimize --eval-dir ~/.claude/relvetia-evals
```

This will:
1. Load the eval suite and latest baseline
2. Split cases into optimization (70%) and holdout (30%) sets
3. Generate candidate threshold changes (±0.01, ±0.02, ±0.05 for each parameter)
4. Test each candidate: accept only if optimization improves AND holdout doesn't regress
5. Output a recommended config to `~/.claude/relvetia-evals/recommended-config.json`

## Step 2: Report results

After the optimization completes, report:
- Number of candidates tested and accepted
- Changes to recommended config (parameter, old value, new value)
- Optimization set pass rate (before → after)
- Holdout set pass rate (before → after)
- Whether the recommended config differs from current defaults

If the recommended config is unchanged, report "Current config is optimal for the eval suite."

## Step 3: Record to daily log

Append optimization results to today's daily log:
```
- [HH:MM] [evals][optimize] Hill-climb: N candidates tested, M accepted. Opt: X% → Y%, Holdout: A% → B%
```

## Important

- Do NOT modify screeningConfig.ts directly — it is immutable
- The recommended config requires human review via `/relvetia eval approve`
- If no baseline exists, run `--baseline` first
