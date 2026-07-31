// Combat-log wording for a felled tree. Pure for unit tests; keep in sync
// with agent-client/src/driver/prompt.rs felled_line.

export interface LogDefLike {
  name: string
}

export function fellMessage(
  def: LogDefLike | undefined,
  fallbackId: string,
  logs: number
): string {
  const name = def?.name ?? fallbackId
  if (logs === 1) return `The tree falls — you cut a ${name}.`
  return `The tree falls — you cut ${logs} ${name}s.`
}
