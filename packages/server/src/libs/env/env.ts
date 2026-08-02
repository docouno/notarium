// Tiny .env loader (no dependency). Existing process.env always wins — the file
// only fills gaps, so container-injected env vars are never overridden.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Load the nearest `.env`, walking up from `startDir` (default cwd). The walk lets
 * it find the repo-root `.env` even when cwd is a workspace package.
 */
export const loadEnv = (startDir = process.cwd(), maxDepth = 5): void => {
  let dir = startDir

  for (let i = 0; i < maxDepth; i++) {
    if (tryLoad(join(dir, '.env'))) {
      return
    }
    const parent = dirname(dir)

    if (parent === dir) {
      break
    }
    dir = parent
  }
  console.warn('[env] no .env file found — relying on process environment')
}

const tryLoad = (path: string): boolean => {
  let raw: string

  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }

    return false
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const eq = trimmed.indexOf('=')

    if (eq === -1) {
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = val
    }
  }

  return true
}
