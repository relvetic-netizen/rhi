# @rhi/shared

Shared wire types and cross-package contracts for the RHI monorepo. No runtime
dependencies — pure type/interface surface that other packages import via
`workspace:*`.

## Contents

- **`LlmExecutor`** (`src/llm.ts`) — the LLM execution seam. A pluggable backend
  that runs a single prompt to completion (`execute(prompt, opts)`). The daemon's
  `CliLlmAdapter` implements it over the Claude CLI; inject a different
  implementation to drive a non-Claude backend without touching the scheduler.

## Roadmap

Further wire contracts are planned to migrate here so producers and consumers
share one definition: on-disk index records (`ResidualEntry` / `ResidualIndex`),
the screening config **schema** (threshold *values* stay in their owning
package and are never relocated), retrieval request/response envelopes,
`CronTask` / `CronJitterConfig`, and the corpus manifest. These currently live
in `@rhi/extracted`; consolidation is deferred until it can be done without
mutating that package's internals.
