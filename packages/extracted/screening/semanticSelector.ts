// Semantic memory selector — Stage 2 of the two-stage pipeline.
//
// After TF-IDF screening (Stage 1) reduces ~200 memory files to ~30,
// this module asks Claude Sonnet via `claude -p` to select the most
// relevant ones. This is the same pattern as ClaudeCLI288's
// selectRelevantMemories() but uses the CLI instead of direct API
// calls, so it's covered by Claude Max plan at no additional cost.
//
// Architecture:
//   Stage 1: screenMemories()     — TF-IDF + Trim-and-Square (local, ~0ms)
//   Stage 2: selectWithSonnet()   — Claude CLI semantic selection (~2-5s)

import { execFile } from 'child_process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCandidate = {
  filename: string
  description: string | null
  type?: string
  /** First ~300 chars of file content for richer context. */
  contentSnippet?: string
}

export type SemanticSelectorOptions = {
  /** Claude model to use. Default: 'sonnet'. */
  model?: string
  /** Maximum memories to select. Default: 5. */
  maxSelect?: number
  /** Timeout in ms for the claude -p call. Default: 30s. */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// System prompt — adapted from ClaudeCLI288's SELECT_MEMORIES_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

const SELECTOR_SYSTEM_PROMPT = `You are reviewing pre-screened memory candidates for relevance to a user's query. Stage 1 (TF-IDF screening) has already filtered out clearly irrelevant items. Your job is a final quality check — remove only items that are obviously wrong, and keep everything else.

Return ONLY a JSON object with a "selected_memories" array of filenames. No other text.

Rules:
- Review each candidate. INCLUDE it unless you are certain it is irrelevant to the query.
- When in doubt, INCLUDE. Missing relevant information is far worse than including extra context.
- You may select up to {maxSelect} memories. Prefer including more over fewer.
- Only return an empty array if ALL candidates are clearly irrelevant.
- Return ONLY valid JSON, nothing else.`

// ---------------------------------------------------------------------------
// Manifest formatting — matches ClaudeCLI288's formatMemoryManifest()
// ---------------------------------------------------------------------------

function formatManifest(memories: MemoryCandidate[]): string {
  return memories
    .map(m => {
      const parts: string[] = []
      if (m.type) parts.push(`[${m.type}]`)
      parts.push(m.filename)
      if (m.description) parts.push(`— ${m.description}`)
      if (m.contentSnippet) {
        const preview = m.contentSnippet.slice(0, 200).replace(/\n/g, ' ')
        parts.push(`(${preview}...)`)
      }
      return `- ${parts.join(' ')}`
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Core selector
// ---------------------------------------------------------------------------

/**
 * Ask Claude Sonnet to select the most relevant memories from a pre-screened
 * candidate list. Uses `claude -p` (covered by Max plan, no API cost).
 *
 * @param query - User's query or task context
 * @param candidates - Pre-screened memory candidates from Stage 1
 * @param opts - Options (model, maxSelect, timeout)
 * @returns Array of selected filenames. Empty on error (graceful degradation).
 */
export async function selectWithSonnet(
  query: string,
  candidates: MemoryCandidate[],
  opts: SemanticSelectorOptions = {},
): Promise<string[]> {
  if (candidates.length === 0) return []

  const {
    model = 'sonnet',
    maxSelect = 5,
    timeoutMs = 30_000,
  } = opts

  const validFilenames = new Set(candidates.map(c => c.filename))
  const manifest = formatManifest(candidates)

  const systemPrompt = SELECTOR_SYSTEM_PROMPT.replace('{maxSelect}', String(maxSelect))

  const userMessage = `Query: ${query}\n\nAvailable memories:\n${manifest}`

  // Build the full prompt — system + user in a single -p string.
  // claude -p treats the input as the user message, so we embed the
  // system instruction at the top.
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`

  try {
    const stdout = await runClaude(fullPrompt, model, timeoutMs)
    return parseSelectedMemories(stdout, validFilenames)
  } catch (e) {
    console.warn(
      `[relvetia-selector] selectWithSonnet failed: ${e instanceof Error ? e.message : e}`,
    )
    return []
  }
}

// ---------------------------------------------------------------------------
// Claude CLI invocation
// ---------------------------------------------------------------------------

function runClaude(
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['--model', model, '--max-turns', '1', '--print', '-p', prompt],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB (response is small)
        env: {
          ...process.env,
          ECC_SKIP_OBSERVE: '1',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          if ('killed' in error && error.killed) {
            reject(new Error(`Selector timed out after ${timeoutMs}ms`))
            return
          }
          // Non-zero exit but got output — try to use it
          if (stdout) {
            resolve(stdout)
            return
          }
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Extract selected filenames from Sonnet's response.
 * Handles both clean JSON and JSON embedded in markdown code blocks.
 */
function parseSelectedMemories(
  response: string,
  validFilenames: Set<string>,
): string[] {
  const text = response.trim()

  // Try to extract JSON from code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const jsonStr = codeBlockMatch ? codeBlockMatch[1]!.trim() : text

  // Try to find JSON object in the response
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed.selected_memories)) return []
    return parsed.selected_memories.filter(
      (f: unknown): f is string => typeof f === 'string' && validFilenames.has(f),
    )
  } catch {
    return []
  }
}
