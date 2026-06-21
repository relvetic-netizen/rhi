# Screening — upstream provenance

## Source

- Upstream repo: relvetia (private)
- Upstream path: `~/workspace/relvetia/relvetia-extracted/screening/`
- Pinned commit: `0f573945e2134ee9e33c38b6de30ec8bae493a0c`
- Ported on: 2026-05-16

## License status

Same author / private workspace; vendored into this repo for runtime
self-containment. Not externally licensed for public redistribution — the
vendored copy must stay inside relvetia-team and is not republished separately.

## Files ported (logic-identical port — only TypeScript type annotations and
the BM25 family were stripped)

| File | Upstream | Notes |
|---|---|---|
| `stopwords.js` | `stopwords.ts` | Full port. Word list identical. |
| `stemmer.js` | `stemmer.ts` | Full port. `stem()` only export. |
| `bilingualBridge.js` | `bilingualBridge.ts` | Full port. `extractBridgeTokens()` only export. Map entries identical. |
| `screening.js` | `screening.ts` | **Partial port** (see "Functions ported" below). |
| `config.js` | (not from upstream — see below) | Constants only, plain JS. |

## Functions ported from `screening.ts`

| Function | Reason |
|---|---|
| `tokenize` | Required by every screening call. |
| `buildIdfMap` | TF-IDF corpus construction. |
| `tfidfVector` | Sparse document vector. |
| `cosineSimilarity` | Similarity measure. |
| `trimAndSquare` | Paper's core activation. |
| `sharpnessFromThreshold` | Threshold → r conversion. |
| `recencyFactor` | Optional recency decay. |
| `screenItems` | Public API used by briefing / memory. |

## Functions intentionally NOT ported (deferred / not needed)

- `screenItemsBM25`, `bm25Score`, `buildBm25CorpusStats` — BM25 family. The
  Codex pre-port review flagged BM25 as out of scope for the P1 cut; TF-IDF
  is what relvetia-team's current callers need.
- `setScreeningDiagnostics`, `setBm25Diagnostics` — diagnostics callbacks.
  relvetia-team already has its own `emitEvent('memory.capped', ...)`
  pathway; a second observer slot would add observability without a consumer.
- All `*Stats` and `Bm25*` types — TypeScript-only declarations.

These exclusions are deliberate. Do **not** re-add them as drive-by edits;
file an issue so the trade-off is reviewed and the golden fixture is
regenerated together.

## `screeningConfig.ts` was not ported

Upstream's `screeningConfig.ts` mixes app-specific tuning, persisted state,
and runtime knobs that do not apply here. Only the constants `relvetia-team`
needs were re-derived in `config.js`. Keep the two files mentally independent.

## Golden fixture

- Generator: `scripts/gen-screening-fixture.mjs`
- Output: `src/__tests__/fixtures/screening-golden.json`
- The fixture header records the upstream commit hash so a future port can
  detect drift before re-vendoring.

### Re-generation procedure

Only run when the vendored ports are intentionally re-aligned with upstream.
`tsx` is not added to `package.json`; we fetch it on-demand:

```bash
cd ~/workspace/relvetia-team
npx -p tsx@4 -- tsx scripts/gen-screening-fixture.mjs
```

The script writes a fresh `screening-golden.json`. Inspect the diff, then
commit alongside the corresponding ports.

### CI drift signal

`screening.test.js` checks the fixture re-runs (against the vendored JS)
deep-equal exactly. A future drift-warning check can compare
`_meta.upstream_commit` to `git -C ~/workspace/relvetia/relvetia-extracted
rev-parse HEAD` — out of scope for this PR but the field is there so it can
be added cheaply.

## Don't

- Don't edit the ported files to "improve" them. Keep the logic identical to
  upstream; if upstream changes, regenerate the fixture and re-port.
- Don't add `tsx` to `package.json` dependencies. One-shot via `npx -p` is
  intentional — production code path must not pull in a transpiler.
- Don't re-introduce BM25 or diagnostics callbacks without a real consumer.
