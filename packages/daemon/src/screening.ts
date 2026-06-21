// Re-export screening module for daemon context.
// The core algorithm lives in extracted/screening/ and is shared
// between the daemon and the CLI. This file provides convenient imports.

export {
  tokenize,
  buildIdfMap,
  tfidfVector,
  cosineSimilarity,
  trimAndSquare,
  sharpnessFromThreshold,
  recencyFactor,
  screenItems,
  setScreeningDiagnostics,
  type ScreeningConfig,
  type ScoredItem,
  type ScreeningStats,
} from '../../extracted/screening/screening.js'

export {
  logScreeningEvent,
  enableScreeningLog,
  isScreeningLogEnabled,
} from '../../extracted/screening/screeningLog.js'

export {
  getScreeningConfig,
  parseScreeningConfig,
  setScreeningConfig,
  DEFAULT_SCREENING_CONFIG,
  type ScreeningConfigShape,
} from '../../extracted/screening/screeningConfig.js'

export {
  screenMemories,
  memoryScreeningConfig,
  type MemoryHeaderLike,
} from '../../extracted/screening/memoryScreening.js'

export {
  searchMemoryWithScreening,
  type SearchResult,
} from '../../extracted/screening/memorySearch.js'

export {
  selectWithSonnet,
  type MemoryCandidate,
  type SemanticSelectorOptions,
} from '../../extracted/screening/semanticSelector.js'

export {
  findRelevantMemories,
  type RelevantMemory,
  type FindMemoriesOptions,
} from '../../extracted/screening/findRelevantMemories.js'
