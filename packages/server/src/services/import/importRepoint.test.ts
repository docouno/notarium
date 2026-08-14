// What an import REPORTS when a repoint could not be proven.
//
// The rewriter refuses rather than guessing: it re-reads its own output and raises
// when the result does not hold exactly the links the source held under the map. A
// note whose internal links were therefore left pointing at the corpus it was
// copied from still imports — that is the partial-import model — but it used to
// leave in `imported` looking exactly like a note whose links HAD been moved, and
// nothing on the wire said otherwise.
//
// The rewriter is mocked, deliberately. A refusal depends on the lexer's exact
// token/source disagreement and is awkward to force through this orchestration
// test. This seam pins the reporting channel; reachable Markdown cases and the
// rewriter's total proof live in core.

import AdmZip from 'adm-zip'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Core from '@notarium/core'

import { IMPORT_DETAIL_CAP } from './consts'
import { runImport } from './importService'

const UNPROVABLE = '[[notarium-id:src-unprovable]]'

vi.mock('@notarium/core', async () => {
  const actual = await vi.importActual<typeof Core>('@notarium/core')

  return {
    ...actual,
    rewriteWikilinkIdentities: (markdown: string, map: ReadonlyMap<string, string>) => {
      if (markdown.includes(UNPROVABLE)) {
        throw new actual.WikilinkRewriteError('rewritten links [] are not ["notarium-id:t-1"]')
      }

      return actual.rewriteWikilinkIdentities(markdown, map)
    },
  }
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notarium-import-repoint-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type WriteCall = { fileName?: string; content?: string }

const storeOf = () => {
  const writes: WriteCall[] = []

  return {
    writes,
    store: {
      list: async () => [],
      checkpoint: async () => {},
      write: async (input: WriteCall) => {
        writes.push(input)

        return { id: `n${writes.length}` }
      },
    },
  }
}

const uploadOf = async (members: Array<{ name: string; body: string }>): Promise<string> => {
  const zip = new AdmZip()

  for (const member of members) {
    zip.addFile(member.name, Buffer.from(member.body, 'utf8'))
  }
  const path = join(dir, 'vault.zip')

  await writeFile(path, zip.toBuffer())

  return path
}

describe('a repoint the rewriter could not prove (#302)', () => {
  it('imports the note, keeps the author’s bytes, and warns on that file', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: '# A\n\nAlpha.\n' },
      { name: 'vault/b.md', body: `# B\n\nSee ${UNPROVABLE}.\n` },
    ])
    const { store, writes } = storeOf()
    const summary = await runImport({
      store: store as never,
      uploadPath: upload,
      tempDir: dir,
      filename: 'vault.zip',
      principal: 'user:a',
      root: 'imported',
    })

    // Still an import: refusing the whole tree over one note's links would lose
    // work the user asked for, and the note itself is fine.
    expect(summary).toMatchObject({ imported: 2, failed: 0 })
    const b = summary.files.find((file) => file.file === 'vault/b.md')

    expect(b?.warnings).toEqual([expect.stringMatching(/links were left pointing at the source/)])
    // ...and the untouched member says nothing, so the warning names the note that
    // actually lost its repoint rather than the run.
    expect(summary.files.find((file) => file.file === 'vault/a.md')?.warnings).toEqual([])
    // The author's bytes, verbatim: a body edited on a guess is the outcome the
    // rewriter refuses for, and half-editing it here would reintroduce it.
    expect(writes.find((write) => write.fileName === 'b')?.content).toContain(UNPROVABLE)
    // The count says the same thing the warning does. On this archive it is
    // redundant; on the one below it is all there is.
    expect(summary.repointFailed).toBe(1)
  })

  // The supported corpus is 10 000 files, and `files` is a 200-row SAMPLE filled in
  // archive order — so on any archive that size the warning above is thrown away
  // before the refusing member is even reached. Measured on the real service rather
  // than argued: without the counter this run reports imported 250, failed 0, no
  // warning anywhere, and a body still pointing at the source.
  it('reports a refusal that happens past the detail cap', async () => {
    const members = Array.from({ length: IMPORT_DETAIL_CAP + 49 }, (_, i) => ({
      name: `vault/n${String(i).padStart(3, '0')}.md`,
      body: `# N${i}\n\nBody.\n`,
    }))
    const upload = await uploadOf([
      ...members,
      { name: 'vault/zzz.md', body: `# Z\n\nSee ${UNPROVABLE}.\n` },
    ])
    const { store, writes } = storeOf()
    const summary = await runImport({
      store: store as never,
      uploadPath: upload,
      tempDir: dir,
      filename: 'vault.zip',
      principal: 'user:a',
      root: 'imported',
    })

    expect(summary).toMatchObject({ imported: IMPORT_DETAIL_CAP + 50, failed: 0 })
    // The row that would have carried the warning was never built, and no other row
    // carries one either: the sample is spent on 200 members that lost nothing.
    expect(summary.files).toHaveLength(IMPORT_DETAIL_CAP)
    expect(summary.filesOmitted).toBe(50)
    expect(summary.files.some((file) => file.file === 'vault/zzz.md')).toBe(false)
    expect(summary.files.flatMap((file) => file.warnings)).toEqual([])
    // …so this is the entire report of a note that imported linked to the corpus it
    // was copied from.
    expect(summary.repointFailed).toBe(1)
    expect(writes.find((write) => write.fileName === 'zzz')?.content).toContain(UNPROVABLE)
  })
})
