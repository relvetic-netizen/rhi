// Error utility module — modeled on Claude Code's errors.ts (lines 119-133)

export function errorMessage(e) {
  if (e instanceof Error) return e.message
  return String(e)
}

export function getErrnoCode(e) {
  if (e && typeof e.code === 'string') return e.code
  return undefined
}

export function isEnoent(e) {
  return getErrnoCode(e) === 'ENOENT'
}

export function isEexist(e) {
  return getErrnoCode(e) === 'EEXIST'
}
