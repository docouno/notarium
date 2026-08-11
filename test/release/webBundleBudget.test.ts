import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  evaluateWebBundleBudget,
  runWebBundleBudget,
  WEB_BUNDLE_BUDGET_BYTES,
} from '../../scripts/checkWebBundleBudget.mjs'

const BUDGET = WEB_BUNDLE_BUDGET_BYTES

// Each case owns a throwaway assets tree; `paths` are POSIX-relative, exactly the shape
// the checker reports back.
const withAssets = async (
  files: Array<[path: string, size: number]>,
  assert: (assetsDir: string) => void | Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-bundle-budget-'))
  const assetsDir = join(root, 'assets')

  try {
    await mkdir(assetsDir, { recursive: true })

    for (const [path, size] of files) {
      const target = join(assetsDir, ...path.split('/'))

      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, Buffer.alloc(size))
    }
    await assert(assetsDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const run = (assetsDir: string, budgetBytes?: number) => {
  const logged: string[] = []
  const result = runWebBundleBudget({
    assetsDir,
    budgetBytes,
    log: (line: string) => logged.push(line),
  })

  return { ...result, logged }
}

describe('web bundle per-chunk budget', () => {
  it('holds the production budget at one mebibyte', () => {
    expect(WEB_BUNDLE_BUDGET_BYTES).toBe(1024 * 1024)
  })

  it('passes a chunk of exactly the budget and blocks one byte more', async () => {
    await withAssets([['index-exact.js', BUDGET]], (assetsDir) => {
      expect(run(assetsDir).blockers).toEqual([])
    })
    await withAssets([['index-over.js', BUDGET + 1]], (assetsDir) => {
      const result = run(assetsDir)

      expect(result.blockers).toEqual([
        `index-over.js: ${BUDGET + 1} B exceeds the ${BUDGET} B budget — over by 1 B`,
      ])
      expect(result.logged.join('\n')).toContain(assetsDir)
    })
  })

  // The chunk count is asserted because it is the only shape signal a green build emits:
  // a family that stopped matching costs a chunk long before it costs the budget.
  it('reports the true largest chunk, the count and the limit on success', async () => {
    await withAssets(
      [
        ['editor-a1.js', 4096],
        ['index-b2.js', 8192],
        ['graph-c3.js', 2048],
      ],
      (assetsDir) => {
        const result = run(assetsDir)

        expect(result.blockers).toEqual([])
        expect(result.largest).toEqual({ path: 'index-b2.js', size: 8192 })
        expect(result.logged.join('\n')).toContain('3 JS chunk(s)')
        expect(result.logged.join('\n')).toContain('largest index-b2.js at 8192 B')
        expect(result.logged.join('\n')).toContain(`(limit ${BUDGET} B)`)
      },
    )
  })

  it('reports every offender in lexical path order, whatever the walk order', async () => {
    await withAssets(
      [
        ['z-last.js', 300],
        ['nested/m-middle.js', 200],
        ['a-first.js', 100],
        ['under.js', 64],
      ],
      (assetsDir) => {
        const result = run(assetsDir, 64)

        expect(result.blockers).toEqual([
          'a-first.js: 100 B exceeds the 64 B budget — over by 36 B',
          'nested/m-middle.js: 200 B exceeds the 64 B budget — over by 136 B',
          'z-last.js: 300 B exceeds the 64 B budget — over by 236 B',
        ])
      },
    )
  })

  it('measures nested chunks and ignores everything that is not a .js file', async () => {
    await withAssets(
      [
        ['deep/inner/chunk.js', 128],
        ['index.css', 4096],
        ['index-abc.js.map', 8192],
        ['data.json', 4096],
        ['KaTeX_Main-Regular.woff2', 4096],
        ['logo.svg', 2048],
      ],
      (assetsDir) => {
        const result = run(assetsDir)

        expect(result.chunks).toEqual([{ path: 'deep/inner/chunk.js', size: 128 }])
      },
    )
  })

  it('fails closed on an empty assets directory', async () => {
    await withAssets([], (assetsDir) => {
      expect(run(assetsDir).blockers).toEqual([
        'no JavaScript chunk to measure — the build produced no output',
      ])
    })
  })

  it('fails closed on a missing assets directory, naming the path', async () => {
    await withAssets([['index.js', 128]], (assetsDir) => {
      const missing = join(assetsDir, 'never-built')
      const result = run(missing)

      expect(result.blockers).toHaveLength(1)
      expect(result.blockers[0]).toContain(missing)
      expect(result.blockers[0]).toContain('is unreadable')
    })
  })

  // `process.exitCode` is asserted absolutely, not against a snapshot taken here: a
  // snapshot would already carry the leak this case exists to catch.
  it('leaves the exit decision to the caller and never exits by itself', async () => {
    await withAssets([['index-over.js', 200]], (assetsDir) => {
      const result = run(assetsDir, 100)

      expect(result.logged).toHaveLength(1)
      expect(result.logged[0]).toContain('web bundle budget blocked')
      expect(process.exitCode).toBeUndefined()
    })
  })

  // The default directory is resolved once, at module evaluation — so the module has to be
  // imported afresh from a foreign cwd for a cwd-relative default to be distinguishable.
  // That needs `process.chdir`, which exists under vitest's default `forks` pool but not
  // under `threads`.
  it('anchors the default assets directory to the repository, not to the caller cwd', async () => {
    const moduleUrl = new URL('../../scripts/checkWebBundleBudget.mjs', import.meta.url).href
    const expected = fileURLToPath(new URL('../../packages/web/dist/assets', import.meta.url))
    const cwd = process.cwd()
    const logged: string[] = []

    process.chdir(tmpdir())
    try {
      const fresh = await import(/* @vite-ignore */ `${moduleUrl}?cwd-anchored`)

      fresh.runWebBundleBudget({ log: (line: string) => logged.push(line) })
    } finally {
      process.chdir(cwd)
    }
    expect(logged.join('\n')).toContain(expected)
  })

  it('classifies from the given sizes alone, with no filesystem access', () => {
    expect(
      evaluateWebBundleBudget([
        { path: 'b.js', size: BUDGET },
        { path: 'a.js', size: BUDGET + 2 },
      ]).blockers,
    ).toEqual([`a.js: ${BUDGET + 2} B exceeds the ${BUDGET} B budget — over by 2 B`])
    expect(evaluateWebBundleBudget([{ path: 'a.js', size: 9 }], 8).blockers).toHaveLength(1)
    expect(evaluateWebBundleBudget([{ path: 'a.js', size: 8 }], 8).blockers).toEqual([])
  })

  it('orders the report lexically, not by the order it was handed the chunks', () => {
    const result = evaluateWebBundleBudget(
      [
        { path: 'z.js', size: 30 },
        { path: 'nested/m.js', size: 20 },
        { path: 'a.js', size: 10 },
      ],
      8,
    )

    expect(result.chunks.map((chunk) => chunk.path)).toEqual(['a.js', 'nested/m.js', 'z.js'])
    expect(result.blockers.map((line) => line.split(':')[0])).toEqual([
      'a.js',
      'nested/m.js',
      'z.js',
    ])
  })
})
