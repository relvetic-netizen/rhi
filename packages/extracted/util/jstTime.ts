// JST time helpers — shared by distillVerifier, topology-runner, and the
// daemon's verifyDreamWork hook.
//
// Why this helper exists: distillVerifier and topology-runner previously
// derived the log-file path from JST (Intl.DateTimeFormat with timeZone
// option) but the in-line timestamp from `now.getHours()` (local time).
// On a JST host the two coincide, but on any other host the file date and
// the row timestamp diverge silently. The helper makes JST the single source
// of truth for both.
//
// Formatted output is robust against small-icu Node builds where 'en-CA' /
// 'en-GB' locales fall back to U.S. format: we use `formatToParts` and pull
// year/month/day/hour/minute by part type, which is locale-independent.

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find(p => p.type === type)?.value ?? ''
}

/** YYYY-MM-DD in JST. Uses formatToParts so small-icu fallbacks (e.g. en-CA
 *  → en-US returning M/D/YYYY) don't silently corrupt the file-path component. */
export function todayJST(date: Date = new Date()): string {
  const parts = dateFormatter.formatToParts(date)
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`
}

/** HH:MM in JST. Returns "00:00" through "23:59" — formatToParts is used to
 *  avoid the `hour12: false` → `24:00` quirk some ICU versions produce. */
export function timeJST(date: Date = new Date()): string {
  const parts = timeFormatter.formatToParts(date)
  const hour = part(parts, 'hour')
  const minute = part(parts, 'minute')
  // ICU edge case: hour12=false sometimes yields "24" instead of "00" at JST midnight.
  return `${hour === '24' ? '00' : hour}:${minute}`
}
