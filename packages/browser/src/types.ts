export interface DomainSkill {
  path: string;
  hostname: string;
  name: string;
  content: string;
  mtime: number;
}

export interface GotoResult {
  url: string;
  hostname: string;
  title: string;
  domainSkills: DomainSkill[];
}

export interface SaveSkillResult {
  path: string;
  bytes: number;
  renamedFrom?: string;
}

export type SaveSkillMode = "versioned" | "fail-if-exists" | "overwrite";

export interface SaveSkillOptions {
  skillsRoot?: string;
  mode?: SaveSkillMode;
  author?: string;
  autoFrontmatter?: boolean;
}

export class SkillExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Skill already exists: ${path}`);
    this.name = "SkillExistsError";
    this.path = path;
  }
}

export interface GotoOptions {
  port?: number;
  skillsRoot?: string;
  maxSkills?: number;
  navigateTimeoutMs?: number;
}

export class InvalidHostnameError extends Error {
  constructor(hostname: string) {
    super(`Invalid hostname: ${JSON.stringify(hostname)}`);
    this.name = "InvalidHostnameError";
  }
}

export class InvalidSkillNameError extends Error {
  constructor(name: string) {
    super(`Invalid skill name: ${JSON.stringify(name)}`);
    this.name = "InvalidSkillNameError";
  }
}

export class PrivatePathLiteralError extends Error {
  readonly matched: string;
  constructor(matched: string) {
    super(`Skill content contains private path literal: ${matched}`);
    this.name = "PrivatePathLiteralError";
    this.matched = matched;
  }
}
