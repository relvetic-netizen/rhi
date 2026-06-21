// Message screening adapter for context compaction.
//
// Scores conversation messages for relevance against the current task
// context using TF-IDF + Trim-and-Square screening. Messages below
// the absolute threshold are flagged as low-relevance candidates for
// aggressive summarization during compaction.
//
// Safety constraints:
// - Never flags tool_use/tool_result message pairs (would break API invariants)
// - Never flags the most recent N messages (active task context)
// - Conservative defaults (low threshold, low sharpness)

import {
  screenItems,
  type ScreeningConfig,
  type ScoredItem,
} from './screening.js'

// ---------------------------------------------------------------------------
// Types — generic message interface to avoid importing ClaudeCLI288 types.
// Callers adapt their specific Message type to this at the boundary.
// ---------------------------------------------------------------------------

export type MessageLike = {
  role: 'user' | 'assistant' | 'system'
  /** Text content blocks extracted from the message. */
  textContent: string
  /** Whether this message is part of a tool_use/tool_result pair. */
  isToolPair?: boolean
  /** Message index in the original array (for mapping back). */
  index: number
}

export type ScoredMessage = {
  index: number
  score: number
  /** True when score is below the threshold (candidate for summarization). */
  lowRelevance: boolean
}

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

/**
 * Build a "current task context" string from the most recent user messages.
 * This serves as the query vector for screening older messages.
 *
 * @param messages - All messages in the conversation
 * @param recentCount - Number of recent user messages to include (default 5)
 * @returns Combined text of recent user messages
 */
export function buildTaskContext(
  messages: MessageLike[],
  recentCount: number = 5,
): string {
  const userMessages = messages.filter(m => m.role === 'user')
  const recent = userMessages.slice(-recentCount)
  return recent.map(m => m.textContent).join(' ')
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Score messages for relevance against the current task context.
 *
 * Messages below the absolute threshold are marked as `lowRelevance: true`.
 * The caller can use this to make compaction decisions — e.g., aggressively
 * summarize or exclude low-relevance messages from the kept set.
 *
 * Safety: tool_use/tool_result pairs and the most recent `protectedCount`
 * messages are never marked as low-relevance regardless of their score.
 *
 * @param messages - Messages to score (adapted to MessageLike)
 * @param config - Screening configuration
 * @param protectedCount - Number of most recent messages to always protect (default 5)
 * @returns Relevance scores for each message, in original index order.
 */
export function screenMessagesForCompaction(
  messages: MessageLike[],
  config: ScreeningConfig,
  protectedCount: number = 5,
): ScoredMessage[] {
  if (messages.length === 0) return []

  const taskContext = buildTaskContext(messages)
  if (!taskContext.trim()) {
    // No user messages → can't determine relevance; mark all as relevant.
    return messages.map(m => ({
      index: m.index,
      score: 1,
      lowRelevance: false,
    }))
  }

  // Screen all messages against the task context.
  const scored = screenItems(
    messages,
    m => m.textContent,
    taskContext,
    { ...config, maxResults: messages.length }, // Don't cap — we need scores for all.
  )

  // Build a score map from screening results.
  const scoreMap = new Map<number, number>()
  for (const s of scored) {
    scoreMap.set(s.item.index, s.score)
  }

  // Protected set: most recent N messages and tool pairs.
  const protectedIndices = new Set<number>()
  const sortedByIndex = [...messages].sort((a, b) => b.index - a.index)
  for (let i = 0; i < Math.min(protectedCount, sortedByIndex.length); i++) {
    protectedIndices.add(sortedByIndex[i]!.index)
  }

  return messages.map(m => {
    const score = scoreMap.get(m.index) ?? 0
    const isProtected =
      protectedIndices.has(m.index) || m.isToolPair === true
    return {
      index: m.index,
      score,
      lowRelevance: !isProtected && score === 0,
    }
  })
}
