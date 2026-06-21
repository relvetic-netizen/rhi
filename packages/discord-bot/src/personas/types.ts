import type { Message, Guild, Interaction } from "discord.js";

export type PersonaName = string;
export type GuildKey = string;

export interface PersonaConfig {
  name: PersonaName;
  /** Vessel dir = persona's CLAUDE.md / heartbeat / prompts / state lives here. workingDir for spawn. */
  vesselDir: string;
  /** Soul dir = persona's MANIFESTO / quests / opinions / ... lives here. */
  soulDir: string;
  /** Path to discord-wake.md used as system prompt. */
  discordWakePath: string;
  /** Per-persona env vars injected into ClaudeSubprocess (RELVETIA_INCLUDE_<NAME>=1 etc). */
  env: Record<string, string>;
  /** Dirs the spawned Claude is allowed to read/write (--add-dir). */
  additionalDirs: string[];
  /** Where per-guild session state JSON files live (`<sessionStateDir>/<guildKey>.json`). */
  sessionStateDir: string;
}

export interface MentionedMember {
  id: string;
  displayName: string;
  roles: string[];
}

export interface ServerMapChannel {
  channelId: string;
  name: string;
  category?: string;
}

export interface ServerMapMember {
  id: string;
  displayName: string;
  primaryRole?: string;
}

export interface ReplyTo {
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

export interface RecentMessage {
  authorName: string;
  content: string;
  timestamp: string;
}

export interface ContextPrefix {
  guild: { id: string; name: string } | null;
  channel: {
    id: string;
    name: string;
    topic?: string;
    type: "text" | "thread" | "dm";
  };
  threadParent?: { channelId: string; channelName: string };
  replyTo?: ReplyTo;
  recentMessages: RecentMessage[];
  mentionedMembers: MentionedMember[];
  serverMap: {
    channels: ServerMapChannel[];
    members: ServerMapMember[];
  };
  notionSchemasAvailable: string[];
}

export interface PersonaSessionOptions {
  persona: PersonaName;
  guildKey: GuildKey;
  model?: string;
}

export class PersonaError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PersonaError";
  }
}

export class TooManySessionsError extends PersonaError {
  constructor(liveCount: number, cap: number) {
    super(`Too many live persona sessions: ${liveCount}/${cap}`);
    this.name = "TooManySessionsError";
  }
}

/** Derive the per-guild session key from a Discord Message or Interaction.
 *  DMs collapse to `DM:<userId>` so the session remains 1:1 with the user. */
export function deriveGuildKey(msg: Message): GuildKey;
export function deriveGuildKey(interaction: Interaction): GuildKey;
export function deriveGuildKey(
  source: { guild: Guild | null; author: { id: string } } | { guild: Guild | null; user: { id: string } }
): GuildKey {
  const guild = source.guild;
  if (guild) return guild.id;
  const userId = "author" in source ? source.author.id : source.user.id;
  return `DM:${userId}`;
}

/** Map key combining persona + guild for global session/lock maps. */
export function makeSessionKey(persona: PersonaName, guildKey: GuildKey): string {
  return `${persona}:${guildKey}`;
}

/** Replace any char unsafe on Windows filesystem (`:` is reserved). */
export function safeFsKey(guildKey: GuildKey): string {
  return guildKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
