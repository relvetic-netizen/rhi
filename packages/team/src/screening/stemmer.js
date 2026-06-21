// Simple English suffix stemmer for TF-IDF tokenization.
//
// NOT a full Porter/Snowball stemmer — deliberately minimal to avoid
// over-stemming (which hurts precision). Strips the most common English
// inflectional suffixes so that "failures"→"fail" and "failed"→"fail"
// share a token during TF-IDF matching.
//
// Vendored from upstream relvetia/screening/stemmer.ts (see UPSTREAM.md).
// Logic-identical port; only TypeScript type annotations were stripped.

const STEM_EXCEPTIONS = new Set([
  'used', 'based', 'named', 'defined', 'required',
  'using', 'being', 'during', 'nothing', 'something',
  'getting', 'setting', 'running', 'building',
  'string', 'testing', 'existing', 'missing',
  'files', 'rules', 'routes', 'types', 'notes',
])

/**
 * Stem an English token by stripping common inflectional suffixes.
 * Returns the stemmed form, or the original token if no rule applies.
 */
export function stem(token) {
  if (token.length < 4) return token
  if (STEM_EXCEPTIONS.has(token)) return token

  if (token.endsWith('ied') && token.length > 5) {
    return token.slice(0, -3) + 'y'
  }

  if (token.endsWith('ies') && token.length > 5) {
    return token.slice(0, -3) + 'y'
  }

  if (token.endsWith('ing') && token.length > 6) {
    const base = token.slice(0, -3)
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1)
    }
    return base
  }

  if (token.endsWith('ures') && token.length > 6) {
    return token.slice(0, -4)
  }

  if (token.endsWith('ure') && token.length > 5) {
    return token.slice(0, -3)
  }

  if (token.endsWith('ed') && token.length > 5) {
    const base = token.slice(0, -2)
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) {
      return base.slice(0, -1)
    }
    return base
  }

  if (token.endsWith('er') && token.length > 6) {
    return token.slice(0, -2)
  }

  if (token.endsWith('est') && token.length > 6) {
    return token.slice(0, -3)
  }

  if (token.endsWith('ly') && token.length > 5) {
    return token.slice(0, -2)
  }

  if (token.endsWith('es') && token.length > 5) {
    const pre = token.slice(0, -2)
    const lastChar = pre[pre.length - 1]
    if (lastChar === 's' || lastChar === 'x' || lastChar === 'z') {
      return pre
    }
    if (pre.endsWith('ch') || pre.endsWith('sh')) {
      return pre
    }
    return token.slice(0, -1)
  }

  if (token.endsWith('s') && token.length > 4) {
    if (token[token.length - 2] === 's') return token
    return token.slice(0, -1)
  }

  return token
}
