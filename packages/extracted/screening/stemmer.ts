// Simple English suffix stemmer for TF-IDF tokenization.
//
// NOT a full Porter/Snowball stemmer — deliberately minimal to avoid
// over-stemming (which hurts precision). Strips the most common English
// inflectional suffixes so that "failures"→"fail" and "failed"→"fail"
// share a token during TF-IDF matching.
//
// Design: each token produces ONE stem. Both query and document tokens
// are stemmed before TF-IDF, so matches happen at the stem level.
// Original tokens are also kept alongside stems in tokenize() for
// exact-match boosting.

// ---------------------------------------------------------------------------
// Exceptions — common words whose stems are misleading
// ---------------------------------------------------------------------------

const STEM_EXCEPTIONS = new Set([
  // Don't stem these — their "stems" collide with unrelated words
  'used', 'based', 'named', 'defined', 'required',
  'using', 'being', 'during', 'nothing', 'something',
  'getting', 'setting', 'running', 'building',
  'string', 'testing', 'existing', 'missing',
  'files', 'rules', 'routes', 'types', 'notes',
])

// ---------------------------------------------------------------------------
// Stemmer
// ---------------------------------------------------------------------------

/**
 * Stem an English token by stripping common inflectional suffixes.
 *
 * Returns the stemmed form, or the original token if no rule applies.
 * Minimum remaining length prevents over-stemming of short words.
 *
 * Examples:
 *   "failures" → "fail"
 *   "failed"   → "fail"
 *   "monitoring" → "monitor"
 *   "changes" → "change"
 *   "headers" → "header"
 *   "security" → "security" (no rule)
 */
export function stem(token: string): string {
  if (token.length < 4) return token
  if (STEM_EXCEPTIONS.has(token)) return token

  // Order matters: try longer suffixes first to avoid partial stripping.

  // -ying → -y (e.g., "modifying" → won't match, too short after)
  // -ied → -y (e.g., "modified" → "modify", "applied" → "apply")
  if (token.endsWith('ied') && token.length > 5) {
    return token.slice(0, -3) + 'y'
  }

  // -ies → -y (e.g., "entries" → "entry", "queries" → "query")
  if (token.endsWith('ies') && token.length > 5) {
    return token.slice(0, -3) + 'y'
  }

  // -ation → -ate (e.g., "authorization" → preserve more, but let's skip complex)
  // -ment → keep (e.g., "management" — too aggressive to strip)
  // -ness → keep (e.g., "freshness" — too aggressive)

  // -ing → "" (e.g., "monitoring" → "monitor", "onboarding" → "onboard")
  if (token.endsWith('ing') && token.length > 6) {
    const base = token.slice(0, -3)
    // Handle doubled consonant: "running" → "run" not "runn"
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1)
    }
    return base
  }

  // -ures → -ure → "" (e.g., "failures" → "fail")
  if (token.endsWith('ures') && token.length > 6) {
    return token.slice(0, -4)
  }

  // -ure → "" (e.g., "failure" → "fail")
  if (token.endsWith('ure') && token.length > 5) {
    return token.slice(0, -3)
  }

  // -ed → "" (e.g., "failed" → "fail", "configured" → "configur")
  if (token.endsWith('ed') && token.length > 5) {
    const base = token.slice(0, -2)
    // Handle doubled consonant: "stopped" → "stop"
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1)
    }
    return base
  }

  // -er → "" (e.g., "handler" → "handl", "member" → keep via length)
  if (token.endsWith('er') && token.length > 6) {
    return token.slice(0, -2)
  }

  // -est → "" (e.g., "fastest" → "fast")
  if (token.endsWith('est') && token.length > 6) {
    return token.slice(0, -3)
  }

  // -ly → "" (e.g., "silently" → "silent")
  if (token.endsWith('ly') && token.length > 5) {
    return token.slice(0, -2)
  }

  // -es → strip only when preceded by sibilant (s, x, z, ch, sh).
  // "processes" → "process", "watches" → "watch", "boxes" → "box"
  // But NOT "changes" (should strip -s only → "change").
  if (token.endsWith('es') && token.length > 5) {
    const pre = token.slice(0, -2)
    const lastChar = pre[pre.length - 1]
    // Sibilant endings where -es is the proper suffix
    if (lastChar === 's' || lastChar === 'x' || lastChar === 'z') {
      return pre
    }
    if (pre.endsWith('ch') || pre.endsWith('sh')) {
      return pre
    }
    // Otherwise strip just -s (e.g., "changes" → "change", "types" → "type")
    return token.slice(0, -1)
  }

  // -s → "" (e.g., "headers" → "header", "metrics" → "metric")
  if (token.endsWith('s') && token.length > 4) {
    // Don't strip -ss (e.g., "access", "process")
    if (token[token.length - 2] === 's') return token
    return token.slice(0, -1)
  }

  return token
}
