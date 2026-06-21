/** Personas module — entry hub for re-exports. */
export { routeMentionToPersona, deriveGuildKey } from "./router.js";
export {
  ensureSession,
  sendUserMessage,
  killSession,
  destroyAllSessions,
  getSession,
  getLiveSessionCount,
  getTurnCount,
  writeStopTombstone,
  isStopTombstoned,
  clearStopTombstone,
} from "./spawn.js";
export {
  withGuildLock,
  startCleanupJob,
  stopCleanupJob,
  clearGuildSession,
  QueueFullError,
} from "./session-manager.js";
export { getPersona, requirePersona, knownPersonas } from "./registry.js";
export {
  PersonaError,
  TooManySessionsError,
  makeSessionKey,
  safeFsKey,
} from "./types.js";
export type {
  ContextPrefix,
  GuildKey,
  PersonaName,
  PersonaConfig,
  PersonaSessionOptions,
  MentionedMember,
  ServerMapChannel,
  ServerMapMember,
  ReplyTo,
  RecentMessage,
} from "./types.js";
