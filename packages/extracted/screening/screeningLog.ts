// Lightweight diagnostic logger for screening events.
//
// Writes structured JSON lines to stderr so they don't interfere with
// stdout-based tool output. Each line is a self-contained event that
// can be parsed by log aggregators, grep, or jq.
//
// Logging is opt-in: disabled by default, enabled via enableScreeningLog().

// Auto-enable when RELVETIA_SCREENING_SEARCH=1 is set in the environment.
// This propagates through PM2 (daemon parent) and spawned children
// (verify-runner / search-runner / MemorySearchTool) without explicit
// enableScreeningLog(true) calls in each entry point.
let _enabled = process.env.RELVETIA_SCREENING_SEARCH === '1'

/** Enable or disable screening diagnostic logging. */
export function enableScreeningLog(enabled: boolean): void {
  _enabled = enabled
}

/** Returns whether screening logging is currently enabled. */
export function isScreeningLogEnabled(): boolean {
  return _enabled
}

/**
 * Log a screening diagnostic event to stderr as a JSON line.
 * No-op when logging is disabled.
 *
 * @param event - Event name (e.g., 'memory_safety_valve', 'novelty_all_rejected')
 * @param data - Arbitrary key-value pairs for the event
 */
export function logScreeningEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  if (!_enabled) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: `screening:${event}`,
    ...data,
  })
  process.stderr.write(line + '\n')
}
