import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { applySeedExternalSources } from '../../scripts/seedExternalSources'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const plant = async (data: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'notarium-seed-source-'))
  roots.push(dir)
  const filePath = join(dir, 'probe.md')

  await writeFile(filePath, '---\ntitle: Probe\n---\n\n# Probe\n\nplaceholder\n', 'utf8')
  await applySeedExternalSources([
    {
      note: 'probe',
      filePath,
      source: { encoding: 'utf8', data },
      tokens: { noteId: 'AbCdEfGhIjKl', path: 'probe.md', createdAt: '2026-01-01T00:00:00.000Z' },
    },
  ])

  return readFile(filePath)
}

describe('applySeedExternalSources', () => {
  // The seam exists for shapes an authoring write cannot produce. If the applier
  // normalises them on the way to disk, the stand carries a state nobody declared and the
  // next task verifies something that is not there.
  it('lands an encoding prologue on disk as the three bytes it is', async () => {
    const bytes = await plant('﻿---\ntitle: Probe\nnotarium-id: {{noteId}}\n---\n\n# Probe\n')

    // The default TextDecoder CONSUMES a leading mark; only `ignoreBOM` keeps it, and
    // without it the seam silently plants the very shape it was built to avoid.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.toString('utf8')).toContain('notarium-id: AbCdEfGhIjKl')
  })

  it('lands a leading blank line before a rule without trimming it', async () => {
    const bytes = await plant('\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n')

    expect(bytes.toString('utf8')).toBe(
      '\n---\nA thought I wrote between two rules.\n---\nAnd the rest.\n',
    )
  })

  it('substitutes every declared token, the same way revisionStates does', async () => {
    const bytes = await plant('id={{noteId}} path={{path}} created={{createdAt}}\n')

    expect(bytes.toString('utf8')).toBe(
      'id=AbCdEfGhIjKl path=probe.md created=2026-01-01T00:00:00.000Z\n',
    )
  })

  it('carries base64 bytes through untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'notarium-seed-source-b64-'))
    roots.push(dir)
    const filePath = join(dir, 'probe.md')

    await writeFile(filePath, 'placeholder', 'utf8')
    await applySeedExternalSources([
      {
        note: 'probe',
        filePath,
        source: { encoding: 'base64', data: Buffer.from('﻿# Hi\n', 'utf8').toString('base64') },
        tokens: { noteId: 'x', path: 'probe.md', createdAt: '2026-01-01T00:00:00.000Z' },
      },
    ])

    expect([...(await readFile(filePath)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
})
