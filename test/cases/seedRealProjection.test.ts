import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { encodeWikilinkIdentity } from '@notarium/core'

import { buildCaseWorld } from './build'

// #302 — the REAL half of the fixture-pinned physical id (docs/seeds.md#a-fixture-pinned-physical-id-302).
//
// `test/fake-server/seedCatalog.test.ts` proves the pin reaches every projection
// of the FAKE stand. Nothing proved the same of the real applier, and nothing
// could: `scripts/**` is outside the vitest `include`, so the one line that
// forwards the pin (`scripts/seed.ts`, `store.write({ id })`) could be deleted
// with the whole suite still green — which is exactly what a mutation showed.
//
// So this runs the applier for real: the production `NotariumStore` fills a
// throwaway data root, and the assertion is read back off the FILES it wrote,
// which is the projection a stand actually serves. Reading the bytes rather
// than a store API is deliberate — the frontmatter id is what survives a
// restart, and it is what an authored `[[notarium-id:…]]` in a sibling note has
// to match. A minted id would be a different string and every such link in the
// case would resolve to nothing.
//
// It is a subprocess because the applier is a CLI: it reads its paths from the
// server's own env edge and ends by closing the meta-DB and the store, so
// driving it any other way would be testing a copy of it instead of it.
const exec = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const CASE = 'import'

describe('the real seed applier', () => {
  it('writes every case-pinned physical id into the notes it seeds', async () => {
    const world = buildCaseWorld(CASE)
    const pinned = world.events.flatMap((e) =>
      e.op === 'create' && e.physicalId ? [{ space: e.space, path: e.path, id: e.physicalId }] : [],
    )

    // A guard on the fixture itself: if the case stops pinning anything, this
    // test would pass vacuously and the mutation would go green again.
    expect(pinned.length).toBeGreaterThan(0)
    const sourceTagged = world.events.flatMap((event) =>
      event.op === 'create' && event.sourceLocator
        ? [{ space: event.space, path: event.path, locator: event.sourceLocator }]
        : [],
    )
    expect(sourceTagged.length).toBeGreaterThan(0)

    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-seed-real-'))

    try {
      await exec(
        join(repoRoot, 'node_modules', '.bin', 'tsx'),
        [join(repoRoot, 'scripts/seed.ts')],
        {
          cwd: repoRoot,
          env: { ...process.env, CASE, DATA_DIR: dataDir, NOW: world.now },
        },
      )

      // Parity with what the case AUTHORED: every exact link the seeded bytes
      // carry to a pinned id must name a note that really got that id. This is
      // the state a dropped pin produces — a link pointing at an identity
      // nobody owns — rather than merely a different id somewhere.
      const owned = new Set(pinned.map((note) => note.id))

      for (const note of pinned) {
        const file = await readFile(join(dataDir, 'spaces', note.space, note.path), 'utf8')

        expect(`${note.path}: ${file}`).toContain(`notarium-id: ${note.id}`)

        for (const [, target] of file.matchAll(/\[\[notarium-id:([^\]|]+)/g)) {
          if (target.startsWith('seed')) {
            expect(owned).toContain(target)
          }
        }
      }
      for (const note of sourceTagged) {
        const file = await readFile(join(dataDir, 'spaces', note.space, note.path), 'utf8')
        expect(`${note.path}: ${file}`).toContain(`notarium-source: ${note.locator}`)
      }
      const legacy = await readFile(
        join(dataDir, 'spaces/main/conversations/claude/20240101-collision-00fax1ug.md'),
        'utf8',
      )
      expect(legacy).not.toContain('notarium-source:')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
    // The applier boots a real engine, applies migrations and replays a whole
    // case timeline; the default per-test budget is a fraction of that.
  }, 180_000)

  it('writes the wiki-web bracket target pin and its stable authored envelope', async () => {
    const world = buildCaseWorld('wiki-web')
    const targetId = 'seedWikiBracket1'
    const creates = world.events.filter(
      (event): event is Extract<(typeof world.events)[number], { op: 'create' }> =>
        event.op === 'create',
    )
    const target = creates.find((event) => event.physicalId === targetId)
    const source = creates.find((event) => event.title === 'Bracket Link Source')

    expect(target?.op).toBe('create')
    expect(source?.op).toBe('create')
    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-seed-real-wiki-'))

    try {
      await exec(
        join(repoRoot, 'node_modules', '.bin', 'tsx'),
        [join(repoRoot, 'scripts/seed.ts')],
        {
          cwd: repoRoot,
          env: { ...process.env, CASE: 'wiki-web', DATA_DIR: dataDir, NOW: world.now },
        },
      )

      const targetFile = await readFile(
        join(dataDir, 'spaces', target!.space, target!.path),
        'utf8',
      )
      const sourceFile = await readFile(
        join(dataDir, 'spaces', source!.space, source!.path),
        'utf8',
      )

      expect(targetFile).toContain(`notarium-id: ${targetId}`)
      expect(sourceFile).toContain(`[[${encodeWikilinkIdentity(targetId)}|&#91;MCP&#93; Review]]`)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 180_000)
})
