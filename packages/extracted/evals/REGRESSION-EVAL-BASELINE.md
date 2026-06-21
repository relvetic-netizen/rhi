# Regression Eval Baseline (Memory Hardening Phase 5 T5-6)

## Current baseline

| Metric          | Value          |
|-----------------|----------------|
| Cases           | 10             |
| Pass            | 5              |
| **passRate**    | **0.50**       |
| avgScore        | 0.50           |
| Threshold (CI)  | `0.50` (no regression tolerated) |
| Captured on     | 2026-05-19, branch `memory-hardening/phase5-t5-eval-gate` |

`RELVETIA_EVAL_THRESHOLD` defaults to `0.7` inside
`relvetia-extracted/evals/regressionEvalCli.ts`; CI overrides this with
`0.5` in `.github/workflows/test.yml` so the gate matches the captured
baseline.

## Per-category breakdown (baseline run)

| Category               | Score |
|------------------------|-------|
| `multi-resolution`     | 1.00  |
| `privacy-safety-valve` | 1.00  |
| `novelty-accept`       | 1.00  |
| `stale-hit-reject`     | 1.00  |
| `search-recall`        | 0.25  |
| `novelty-reject`       | 0.00  |
| `cross-lingual`        | 0.00  |

The 4 perfect categories include the privacy / safety-valve / stale
fixtures derived from the Phase 0 regression suite, plus the
multi-resolution baseline. The `search-recall` / `novelty-reject` /
`cross-lingual` categories are deliberately tough cases that surface
gaps in the current screening pipeline; they are listed here as the
follow-up work target.

## How the gate works

1. `npm run test:eval` (in `relvetia-daemon/`) invokes
   `tsx ../relvetia-extracted/evals/regressionEvalCli.ts`.
2. The CLI reads
   `relvetia-extracted/evals/regression-evalcases.jsonl` (10 lines).
3. Each case is parsed via `EvalCaseSchema` (Zod), then routed by
   category to the appropriate runner in `evalRunner.ts`.
4. After running, the CLI emits a one-line summary
   `[regression-eval] PASS|FAIL N/M (passRate=… avgScore=… threshold=…)`
   and exits `0` if `passRate >= threshold`, `1` otherwise.
5. CI step `test (eval gate — Memory Hardening Phase 5 regression
   cases)` reads `$RELVETIA_EVAL_THRESHOLD` and gates merges.

## Ratcheting up the threshold

When a follow-up PR improves the screening pipeline so passRate rises
above the current baseline:

1. Re-run `npm run test:eval` on the upgrade branch and capture the new
   passRate.
2. Update this README with the new baseline + a one-line rationale
   linking to the PR that lifted it.
3. Update `RELVETIA_EVAL_THRESHOLD` in `.github/workflows/test.yml` to
   the new floor (typically the new passRate, exact or rounded down).
4. Do NOT lower the threshold below the previously merged baseline
   without a written rationale (e.g. an intentional false-positive case
   added to the fixture). Such a lowering should be in its own PR with
   the rationale in the commit message body.

## Regenerating the fixture

`regression-evalcases.jsonl` is committed to the repo; if the schema
changes or new cases need to be seeded, regenerate via:

```bash
node scripts/gen-regression-evalcases.mjs
```

The script in `scripts/gen-regression-evalcases.mjs` is the canonical
source; the JSONL is checked in so CI runs are deterministic without
extra build steps.

## Dogfood smoke (Phase 5 T5-7)

To verify the gate actually fails when regressions are introduced:

1. On a throwaway branch, downgrade one case (e.g. flip
   `mustHitEntryIds` to an ID that doesn't exist in `memoryEntryIds`).
2. Push and confirm the CI step `test (eval gate — Memory Hardening
   Phase 5 regression cases)` fails with the expected
   `[regression-eval] FAIL` line.
3. Discard the branch (do not merge).

This smoke run was performed at gate landing and is captured in the
sprint completion notes.

## Related files

- `relvetia-extracted/evals/evalTypes.ts` — `EvalCaseSchema` definition
  (extended Phase 5 T5-2)
- `relvetia-extracted/evals/evalRunner.ts` — `runEvalCase` dispatch +
  `runSearchRecallCase` / `runEntryIdRejectionCase` (extended Phase 5
  T5-3)
- `relvetia-extracted/evals/regressionEvalCli.ts` — CI runner (Phase
  5 T5-4)
- `relvetia-extracted/evals/regression-evalcases.jsonl` — fixture data
  (Phase 5 T5-1)
- `relvetia-extracted/evals/evalStore.ts` — `appendMissingEntryRecord`
  for the verifier→evalStore wire (Phase 5 T5-5)
- `relvetia-daemon/src/bootstrap.ts` — `wireDistillVerifierToEvalStore`
  callback registration (Phase 5 T5-5)
- `.github/workflows/test.yml` — CI step + threshold env (Phase 5 T5-4,
  T5-6)
