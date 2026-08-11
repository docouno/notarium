#!/usr/bin/env node

// Per-chunk size gate over the built SPA: no generated JS chunk may exceed the budget.
// canon: docs/pwa.md#bundle-size

import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WEB_BUNDLE_BUDGET_BYTES = 1024 * 1024

// Anchored to this file, not to cwd: the root build, the workspace build and a direct
// `node scripts/…` invocation must all measure the same output.
const DEFAULT_ASSETS_DIR = fileURLToPath(new URL('../packages/web/dist/assets', import.meta.url))

const byPath = (a, b) => {
  if (a.path === b.path) {
    return 0
  }

  return a.path < b.path ? -1 : 1
}

const jsChunksIn = (dir, base = dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      jsChunksIn(path, base, out)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push({ path: relative(base, path).split(sep).join('/'), size: statSync(path).size })
    }
  }

  return out
}

export const evaluateWebBundleBudget = (files, budgetBytes = WEB_BUNDLE_BUDGET_BYTES) => {
  const chunks = [...files].sort(byPath)
  const blockers = chunks
    .filter((chunk) => chunk.size > budgetBytes)
    .map(
      (chunk) =>
        `${chunk.path}: ${chunk.size} B exceeds the ${budgetBytes} B budget — over by ${chunk.size - budgetBytes} B`,
    )

  if (!chunks.length) {
    blockers.push('no JavaScript chunk to measure — the build produced no output')
  }

  return {
    blockers,
    chunks,
    largest: chunks.reduce((widest, chunk) => (chunk.size > widest.size ? chunk : widest), {
      path: null,
      size: -1,
    }),
    budgetBytes,
  }
}

export const runWebBundleBudget = ({
  assetsDir = DEFAULT_ASSETS_DIR,
  budgetBytes = WEB_BUNDLE_BUDGET_BYTES,
  log = console.error,
} = {}) => {
  const dir = resolve(assetsDir)
  let result

  try {
    result = evaluateWebBundleBudget(jsChunksIn(dir), budgetBytes)
  } catch (error) {
    result = {
      blockers: [`${dir} is unreadable: ${error.message}`],
      chunks: [],
      largest: { path: null, size: -1 },
      budgetBytes,
    }
  }

  if (result.blockers.length) {
    log(`web bundle budget blocked in ${dir}:\n  - ${result.blockers.join('\n  - ')}`)
  } else {
    log(
      `web bundle budget passed: ${result.chunks.length} JS chunk(s) in ${dir}; ` +
        `largest ${result.largest.path} at ${result.largest.size} B (limit ${budgetBytes} B)`,
    )
  }

  return result
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = runWebBundleBudget().blockers.length ? 1 : 0
  } catch (error) {
    console.error(`web bundle budget failed: ${error.message}`)
    process.exitCode = 1
  }
}
