export type KillKind = "registry" | "cse";

export type KillDecision =
  | { allowed: true; kind: KillKind }
  | { allowed: false; reason: string };

export interface KillContext {
  botPid: number;
  registryPids: number[];
  cseSessionPids: number[];
}

export function canKill(pid: number, ctx: KillContext): KillDecision {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { allowed: false, reason: "PID is not a positive integer" };
  }
  if (pid === ctx.botPid) {
    return { allowed: false, reason: "bot self-kill 禁止" };
  }
  if (ctx.registryPids.includes(pid)) {
    return { allowed: true, kind: "registry" };
  }
  if (ctx.cseSessionPids.includes(pid)) {
    return { allowed: true, kind: "cse" };
  }
  return { allowed: false, reason: "registry にも cse_session にも該当しない PID" };
}
