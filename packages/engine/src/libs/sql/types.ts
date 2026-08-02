// The engine's SQL seam (P9): a narrow, async-only surface that better-sqlite3,
// node:sqlite, op-sqlite, wa-sqlite and pg can all satisfy. Async from day one
// on purpose — a sync API would be more convenient on Node, but it would shut
// the door on the mobile/browser rungs of the P9 ladder (wa-sqlite over OPFS is
// async by nature). The store speaks ONLY this type; which driver gets plugged
// in is the build profile's choice (#69).

export type SqlValue = null | number | bigint | string | Uint8Array

export type SqlDriver = {
  /** Run a multi-statement script (schema setup). */
  exec(sql: string): Promise<void>
  /** Run one parameterized statement; reports affected-row count. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | undefined>
  close(): Promise<void>
}
