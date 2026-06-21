// Screening configuration constants for relvetia-team.
// Distinct from upstream `screeningConfig.ts` (which is not vendored): this
// only exposes the constants the team integration actually needs.

export const SEARCH_THRESHOLD = 0.10
export const SEARCH_MAX_RESULTS = 20
export const BRIEFING_THRESHOLD = 0.10
export const BRIEFING_FINDING_MAX = 15
export const BRIEFING_KNOWLEDGE_MAX = 20
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600 * 1000

// Search result byte cap (formatted text). Applied after screening + sort,
// keeps highest-scoring items first. See briefing.js / memory.js.
export const SEARCH_RETURN_BUDGET_BYTES = 16_000

// Briefing byte cap (formatted text). Plan v3.1 target. Enforced by the
// team_build_briefing / team_prime_agent handlers via grapheme-safe truncation.
export const BRIEFING_RETURN_BUDGET_BYTES = 32_768
