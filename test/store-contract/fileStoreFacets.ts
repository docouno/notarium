// One spec, every adapter: what a declared facet promises.
//
// The runner attaches a block only to a facet the assembly actually declares, so
// an adapter is never asked about something it said it cannot do — and the same
// file that proves the promises also proves the shape of a refusal, because a
// missing facet simply has no block. That is the whole difference between "this
// deployment cannot" and "this method throws".

import { describe, expect, it } from 'vitest'

import type {
  FileStoreAccelerators,
  FileStoreAssembly,
  FileStoreCapabilities,
} from '@notarium/engine'

export type FileStoreFacetFactory = () => Promise<{
  assembly: FileStoreAssembly
  teardown?: () => Promise<void>
}>

const NOTE = '---\ntitle: Note\n---\n\nbody'

export type FileStoreFacetExpectation = {
  capabilities: readonly (keyof FileStoreCapabilities)[]
  accelerators: readonly (keyof FileStoreAccelerators)[]
  strictRestartDurable?: boolean
}

export const describeFileStoreFacets = (
  name: string,
  expected: FileStoreFacetExpectation,
  factory: FileStoreFacetFactory,
): void => {
  describe(`FileStore facets — ${name}`, () => {
    const expectedCapabilities = new Set<keyof FileStoreCapabilities>(expected.capabilities)
    const expectedAccelerators = new Set<keyof FileStoreAccelerators>(expected.accelerators)

    /** Per case: an adapter carries per-root state, and one shared instance would
     *  make the cases order-dependent. */
    const fresh = async () => {
      const built = await factory()

      return built
    }

    const withAdapter = async (
      run: (assembly: FileStoreAssembly) => Promise<void>,
    ): Promise<void> => {
      const built = await fresh()

      try {
        await run(built.assembly)
      } finally {
        await built.teardown?.()
      }
    }

    const requiredCapability = <Key extends keyof FileStoreCapabilities>(
      capabilities: FileStoreCapabilities,
      key: Key,
    ): NonNullable<FileStoreCapabilities[Key]> | null => {
      if (!expectedCapabilities.has(key)) {
        return null
      }
      expect(Object.hasOwn(capabilities, key)).toBe(true)
      const facet = capabilities[key]

      if (!facet) {
        throw new Error(`expected capability ${key}`)
      }

      return facet as NonNullable<FileStoreCapabilities[Key]>
    }

    const requiredAccelerator = <Key extends keyof FileStoreAccelerators>(
      accelerators: FileStoreAccelerators,
      key: Key,
    ): NonNullable<FileStoreAccelerators[Key]> | null => {
      if (!expectedAccelerators.has(key)) {
        return null
      }
      expect(Object.hasOwn(accelerators, key)).toBe(true)
      const accelerator = accelerators[key]

      if (!accelerator) {
        throw new Error(`expected accelerator ${key}`)
      }

      return accelerator as NonNullable<FileStoreAccelerators[Key]>
    }

    it('declares exactly the expected facets and accelerators', async () => {
      await withAdapter(async ({ capabilities, accelerators }) => {
        expect(Object.keys(capabilities).sort()).toEqual([...expectedCapabilities].sort())
        expect(Object.keys(accelerators).sort()).toEqual([...expectedAccelerators].sort())

        for (const key of expectedCapabilities) {
          expect(capabilities[key]).toBeDefined()
        }
        for (const key of expectedAccelerators) {
          expect(accelerators[key]).toBeDefined()
        }
      })
    })

    describe('base', () => {
      it('round-trips a note, its stat and the inventory it belongs to', async () => {
        await withAdapter(async ({ base }) => {
          await base.write('docs/note.md', NOTE)

          await expect(base.read('docs/note.md')).resolves.toBe(NOTE)
          await expect(base.exists('docs/note.md')).resolves.toBe(true)
          await expect(base.dirExists('docs')).resolves.toBe(true)
          expect((await base.scan()).map((entry) => entry.path)).toEqual(['docs/note.md'])
          expect((await base.stat('docs/note.md'))?.size).toBe(NOTE.length)
          // A pathname nothing owns is not an error — a stat/read race with an
          // external delete is a normal answer.
          await expect(base.read('docs/gone.md')).resolves.toBeNull()
          await expect(base.stat('docs/gone.md')).resolves.toBeNull()
        })
      })

      it('claims a directory once and deletes its subtree wholesale', async () => {
        await withAdapter(async ({ base }) => {
          await expect(base.makeDir('folder')).resolves.toBe(true)
          // The leaf is claimed atomically: a second claim of the same pathname
          // loses rather than silently succeeding.
          await expect(base.makeDir('folder')).resolves.toBe(false)
          await base.write('folder/note.md', NOTE)
          await base.removeDir('folder')

          await expect(base.dirExists('folder')).resolves.toBe(false)
          await expect(base.exists('folder/note.md')).resolves.toBe(false)
          // Idempotent: removing what is already gone is a no-op, not a throw.
          await base.removeDir('folder')
        })
      })

      it('moves a file and a whole subtree with ordinary replacement semantics', async () => {
        await withAdapter(async ({ base }) => {
          await base.write('a/note.md', NOTE)
          await base.rename('a/note.md', 'b/note.md')
          await expect(base.read('b/note.md')).resolves.toBe(NOTE)

          await base.renameDir('b', 'c')
          await expect(base.read('c/note.md')).resolves.toBe(NOTE)
          await expect(base.dirExists('c')).resolves.toBe(true)
        })
      })

      it('removes a file and treats a missing one as already removed', async () => {
        await withAdapter(async ({ base }) => {
          await base.write('note.md', NOTE)
          await base.remove('note.md')
          await expect(base.exists('note.md')).resolves.toBe(false)
          await base.remove('note.md')
        })
      })
    })

    describe('exactRead', () => {
      it('hands back the same bytes read() decodes, and null for an absent path', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const exactRead = requiredCapability(capabilities, 'exactRead')

          if (!exactRead) {
            return
          }
          await base.write('note.md', NOTE)

          const bytes = await exactRead.readBytes('note.md')

          expect(new TextDecoder().decode(bytes!)).toBe(NOTE)
          await expect(exactRead.readBytes('gone.md')).resolves.toBeNull()
        })
      })
    })

    describe('conditionalFileMutation', () => {
      it('creates only into an absent pathname', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const mutation = requiredCapability(capabilities, 'conditionalFileMutation')

          if (!mutation) {
            return
          }
          await expect(mutation.writeIfAbsent('note.md', NOTE)).resolves.toBe(true)
          await expect(mutation.writeIfAbsent('note.md', 'other')).resolves.toBe(false)
          // The occupant kept its bytes: a lost race never half-publishes.
          await expect(base.read('note.md')).resolves.toBe(NOTE)
        })
      })

      it('updates only the exact version the caller read', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const mutation = requiredCapability(capabilities, 'conditionalFileMutation')

          if (!mutation) {
            return
          }
          await base.write('note.md', NOTE)

          // `false` is reserved for an occupied DESTINATION — a caller answers it
          // by picking another name. A source that is no longer what the caller
          // read is a different fact, and it fails the operation instead.
          await expect(
            mutation.replaceIfAbsent('note.md', 'note.md', 'not what is there', 'next'),
          ).rejects.toMatchObject({ code: 'ESTALE' })
          await expect(base.read('note.md')).resolves.toBe(NOTE)
          await expect(mutation.replaceIfAbsent('note.md', 'note.md', NOTE, 'next')).resolves.toBe(
            true,
          )
          await expect(base.read('note.md')).resolves.toBe('next')
        })
      })

      it('refuses to publish a move onto an occupied destination', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const mutation = requiredCapability(capabilities, 'conditionalFileMutation')

          if (!mutation) {
            return
          }
          await base.write('source.md', NOTE)
          await base.write('target.md', 'occupant')

          await expect(
            mutation.replaceIfAbsent('source.md', 'target.md', NOTE, 'next'),
          ).resolves.toBe(false)
          await expect(base.read('target.md')).resolves.toBe('occupant')
          await expect(base.read('source.md')).resolves.toBe(NOTE)
        })
      })

      it('removes only the exact version, and counts an absent one as removed', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const mutation = requiredCapability(capabilities, 'conditionalFileMutation')

          if (!mutation) {
            return
          }
          await base.write('note.md', NOTE)

          await expect(mutation.removeIfUnchanged('note.md', 'stale')).resolves.toBe(false)
          await expect(base.exists('note.md')).resolves.toBe(true)
          await expect(mutation.removeIfUnchanged('note.md', NOTE)).resolves.toBe(true)
          await expect(mutation.removeIfUnchanged('note.md', NOTE)).resolves.toBe(true)
        })
      })
    })

    describe('entryIdentity', () => {
      it('answers true only for one entry reached twice', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const identity = requiredCapability(capabilities, 'entryIdentity')

          if (!identity) {
            return
          }
          await base.write('one.md', NOTE)
          await base.write('two.md', NOTE)

          await expect(identity.sameEntry('one.md', 'one.md')).resolves.toBe(true)
          // Same BYTES are not the same entry — that is the whole distinction the
          // case/NFC exception rests on.
          await expect(identity.sameEntry('one.md', 'two.md')).resolves.toBe(false)
          await expect(identity.sameEntry('one.md', 'gone.md')).resolves.toBe(false)
        })
      })
    })

    describe('fileNoReplaceMove', () => {
      it('claims a free destination and never takes an occupied one', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const noReplace = requiredCapability(capabilities, 'fileNoReplaceMove')

          if (!noReplace) {
            return
          }
          await base.write('source.md', NOTE)
          await expect(noReplace.renameIfAbsent('source.md', 'moved.md')).resolves.toBe(true)
          await expect(base.read('moved.md')).resolves.toBe(NOTE)

          await base.write('rival.md', 'occupant')
          await expect(noReplace.renameIfAbsent('moved.md', 'rival.md')).resolves.toBe(false)
          await expect(base.read('rival.md')).resolves.toBe('occupant')
          await expect(base.read('moved.md')).resolves.toBe(NOTE)
        })
      })
    })

    describe('directoryNoReplaceMove', () => {
      it('claims a free destination and never takes an occupied one', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const directoryMove = requiredCapability(capabilities, 'directoryNoReplaceMove')

          if (!directoryMove) {
            return
          }
          await base.write('docs/note.md', NOTE)
          await expect(directoryMove.renameDirIfAbsent('docs', 'archive')).resolves.toBe(true)
          await expect(base.read('archive/note.md')).resolves.toBe(NOTE)

          await base.makeDir('taken')
          await expect(directoryMove.renameDirIfAbsent('archive', 'taken')).resolves.toBe(false)
          await expect(base.read('archive/note.md')).resolves.toBe(NOTE)
        })
      })
    })

    describe('resourceExport', () => {
      it('streams every regular resource as exact bytes', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const resourceExport = requiredCapability(capabilities, 'resourceExport')

          if (!resourceExport) {
            return
          }
          await base.write('docs/note.md', NOTE)
          await base.write('assets/icon.bin', 'asset')
          const exported: Array<{ path: string; content: string }> = []

          for await (const entry of resourceExport.exportFiles()) {
            exported.push({ path: entry.path, content: new TextDecoder().decode(entry.content) })
          }

          expect(exported.sort((left, right) => left.path.localeCompare(right.path))).toEqual([
            { path: 'assets/icon.bin', content: 'asset' },
            { path: 'docs/note.md', content: NOTE },
          ])
        })
      })
    })

    describe('resourceObservation', () => {
      it('binds exact bytes and a claim to one present or absent sample', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const observation = requiredCapability(capabilities, 'resourceObservation')

          if (!observation) {
            return
          }
          await expect(observation.observe('note.md')).resolves.toMatchObject({ kind: 'absent' })
          await base.write('note.md', NOTE)
          const present = await observation.observe('note.md')

          expect(present).toMatchObject({
            kind: 'present',
            claim: { kind: 'present' },
            mtimeMs: expect.any(Number),
          })
          if (present.kind !== 'present') {
            throw new Error('expected a present resource observation')
          }
          expect(new TextDecoder().decode(present.bytes)).toBe(NOTE)
          await expect(observation.observe('note.md', { maxBytes: 1 })).resolves.toMatchObject({
            kind: 'unavailable',
            reason: 'too-large',
          })
        })
      })
    })

    describe('resourcePublication', () => {
      it('publishes only against the exact claim and leaves a conflict unchanged', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const observation = requiredCapability(capabilities, 'resourceObservation')
          const publication = requiredCapability(capabilities, 'resourcePublication')

          if (!publication) {
            return
          }
          if (!observation) {
            throw new Error('the publication contract fixture needs resource observation')
          }
          const absent = await observation.observe('note.md')

          expect(absent.kind).toBe('absent')
          if (absent.kind !== 'absent') {
            throw new Error('expected an absent publication target')
          }
          await expect(
            publication.publish({
              kind: 'put',
              path: 'note.md',
              content: new TextEncoder().encode(NOTE),
              expected: absent.claim,
            }),
          ).resolves.toMatchObject({
            status: 'published',
            candidateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            transitions: [
              {
                path: 'note.md',
                before: absent.claim,
                after: expect.objectContaining({ kind: 'present' }),
                mtimeMs: expect.any(Number),
              },
            ],
          })
          await expect(
            publication.publish({
              kind: 'put',
              path: 'note.md',
              content: new TextEncoder().encode('rival'),
              expected: absent.claim,
            }),
          ).resolves.toEqual({ status: 'conflict' })
          await expect(base.read('note.md')).resolves.toBe(NOTE)
        })
      })
    })

    describe('claimedRemoval', () => {
      it('removes only the bytes and present claim the caller observed', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const observation = requiredCapability(capabilities, 'resourceObservation')
          const removal = requiredCapability(capabilities, 'claimedRemoval')

          if (!removal) {
            return
          }
          if (!observation) {
            throw new Error('the claimed-removal contract fixture needs resource observation')
          }
          await base.write('note.md', NOTE)
          const present = await observation.observe('note.md')

          expect(present.kind).toBe('present')
          if (present.kind !== 'present') {
            throw new Error('expected a present claimed-removal target')
          }
          await expect(removal.removeIfClaimed('note.md', 'stale', present.claim)).resolves.toBe(
            false,
          )
          await expect(base.exists('note.md')).resolves.toBe(true)
          await expect(removal.removeIfClaimed('note.md', NOTE, present.claim)).resolves.toBe(true)
          await expect(base.exists('note.md')).resolves.toBe(false)
        })
      })
    })

    describe('packagePublication', () => {
      it('publishes a complete absent package and never changes an occupied winner', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const observation = requiredCapability(capabilities, 'resourceObservation')
          const publication = requiredCapability(capabilities, 'packagePublication')

          if (!publication) {
            return
          }
          if (!observation) {
            throw new Error('the package contract fixture needs resource observation')
          }
          const absent = await observation.observe('demo')

          expect(absent.kind).toBe('absent')
          if (absent.kind !== 'absent') {
            throw new Error('expected an absent package target')
          }
          await expect(
            publication.publishPackageIfAbsent({
              rootPath: 'demo',
              files: [
                { path: 'SKILL.md', content: new TextEncoder().encode('manifest') },
                { path: 'assets/icon.bin', content: Uint8Array.of(1, 2, 3) },
              ],
              expectedRoot: absent.claim,
            }),
          ).resolves.toMatchObject({
            status: 'published',
            candidateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            transitions: expect.arrayContaining([
              expect.objectContaining({ path: 'demo', before: absent.claim }),
              expect.objectContaining({ path: 'demo/SKILL.md' }),
              expect.objectContaining({ path: 'demo/assets/icon.bin' }),
            ]),
          })
          await expect(base.read('demo/SKILL.md')).resolves.toBe('manifest')
          await expect(
            publication.publishPackageIfAbsent({
              rootPath: 'demo',
              files: [{ path: 'SKILL.md', content: new TextEncoder().encode('rival') }],
              expectedRoot: absent.claim,
            }),
          ).resolves.toEqual({ status: 'conflict' })
          await expect(base.read('demo/SKILL.md')).resolves.toBe('manifest')
        })
      })
    })

    describe('strictPublication', () => {
      it('declares whether accepted stages survive a restart', async () => {
        await withAdapter(async ({ capabilities }) => {
          const strict = requiredCapability(capabilities, 'strictPublication')
          const declaresRestartDurability = Object.hasOwn(expected, 'strictRestartDurable')

          if (!strict) {
            expect(declaresRestartDurability).toBe(false)
            return
          }

          expect(declaresRestartDurability).toBe(true)
          expect(strict.restartDurable).toBe(expected.strictRestartDurable)
        })
      })

      it('stages, inspects, publishes and discards one bound operation', async () => {
        await withAdapter(async ({ base, capabilities }) => {
          const observation = requiredCapability(capabilities, 'resourceObservation')
          const strict = requiredCapability(capabilities, 'strictPublication')

          if (!strict) {
            return
          }
          if (!observation) {
            throw new Error('the strict-publication contract fixture needs resource observation')
          }
          const absent = await observation.observe('note.md')

          expect(absent.kind).toBe('absent')
          if (absent.kind !== 'absent') {
            throw new Error('expected an absent strict-publication target')
          }
          await expect(
            strict.stage({
              operationId: 'contract-op',
              binding: 'contract-binding',
              path: 'note.md',
              content: new TextEncoder().encode(NOTE),
              expected: absent.claim,
            }),
          ).resolves.toMatchObject({ status: 'accepted', created: true })
          await expect(strict.inspect('contract-op', 'contract-binding')).resolves.toMatchObject({
            status: 'staged',
            stage: { path: 'note.md', candidateHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
          })
          await expect(strict.publish('contract-op', 'contract-binding')).resolves.toMatchObject({
            status: 'published',
            receipt: {
              restartDurable: true,
              transitions: [expect.objectContaining({ path: 'note.md' })],
            },
          })
          await expect(base.read('note.md')).resolves.toBe(NOTE)
          await expect(strict.discard('contract-op', 'contract-binding')).resolves.toBe(true)
          await expect(strict.inspect('contract-op', 'contract-binding')).resolves.toEqual({
            status: 'missing',
          })
        })
      })
    })

    describe('watch', () => {
      it('either establishes a closeable hint channel or honestly declines it', async () => {
        await withAdapter(async ({ capabilities }) => {
          const watch = requiredCapability(capabilities, 'watch')

          if (!watch) {
            return
          }
          const close = watch.watch(() => {})

          expect(close === null || typeof close === 'function').toBe(true)
          close?.()
        })
      })
    })

    describe('exactDirectorySpelling', () => {
      it('answers for a directory and never for a file', async () => {
        await withAdapter(async ({ base, accelerators }) => {
          const spelling = requiredAccelerator(accelerators, 'exactDirectorySpelling')

          if (!spelling) {
            return
          }
          await base.makeDir('folder')
          await base.write('note.md', NOTE)

          await expect(spelling.dirExistsExact('folder')).resolves.toBe(true)
          await expect(spelling.dirExistsExact('note.md')).resolves.toBe(false)
          await expect(spelling.dirExistsExact('missing')).resolves.toBe(false)
        })
      })
    })
  })
}
