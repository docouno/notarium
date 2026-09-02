import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CONTAINER_SUPPORT_MANIFEST,
  copyContainerSupport,
  stageContainerSupport,
} from '../../scripts/checkup/containerSupport.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-container-support-test-'))
  roots.push(root)
  await Promise.all([
    mkdir(join(root, 'scripts'), { recursive: true }),
    mkdir(join(root, 'docker'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'Makefile'), 'makefile\n'),
    writeFile(join(root, 'README.md'), 'readme\n'),
    writeFile(join(root, 'scripts/check.mjs'), 'export {}\n'),
    writeFile(join(root, 'docker/Dockerfile'), 'FROM scratch\n'),
    writeFile(join(root, 'docker/Dockerfile.dockerignore'), 'node_modules\n'),
  ])

  return root
}

describe('container test support carrier', () => {
  it('declares the one complete support corpus', () => {
    expect(CONTAINER_SUPPORT_MANIFEST).toEqual([
      { source: 'Makefile', target: 'Makefile', directory: false },
      { source: 'scripts', target: 'scripts', directory: true },
      { source: 'README.md', target: 'README.md', directory: false },
      { source: 'docker/Dockerfile', target: 'docker/Dockerfile', directory: false },
      {
        source: 'docker/Dockerfile.dockerignore',
        target: 'docker/Dockerfile.dockerignore',
        directory: false,
      },
    ])
  })

  it('stages exact paths without flattening directory contents', async () => {
    const sourceRoot = await fixture()
    const stageRoot = await stageContainerSupport({ sourceRoot })
    roots.push(stageRoot)

    await expect(readFile(join(stageRoot, 'Makefile'), 'utf8')).resolves.toBe('makefile\n')
    await expect(readFile(join(stageRoot, 'README.md'), 'utf8')).resolves.toBe('readme\n')
    await expect(readFile(join(stageRoot, 'scripts/check.mjs'), 'utf8')).resolves.toBe(
      'export {}\n',
    )
    await expect(readFile(join(stageRoot, 'docker/Dockerfile'), 'utf8')).resolves.toBe(
      'FROM scratch\n',
    )
    await expect(readFile(join(stageRoot, 'docker/Dockerfile.dockerignore'), 'utf8')).resolves.toBe(
      'node_modules\n',
    )
  })

  it('copies one staged tree and removes it after success', async () => {
    const sourceRoot = await fixture()
    let staged = ''

    await copyContainerSupport({
      container: 'runner',
      sourceRoot,
      docker: (args: string[]) => {
        expect(args).toEqual(['cp', expect.stringMatching(/[/][.]$/u), 'runner:/app'])
        staged = args[1]!.slice(0, -2)
        return { status: 0 }
      },
    })

    await expect(stat(staged)).rejects.toThrow(/ENOENT/u)
  })

  it('removes the staged tree when Docker rejects the copy', async () => {
    const sourceRoot = await fixture()
    let staged = ''

    await expect(
      copyContainerSupport({
        container: 'runner',
        sourceRoot,
        docker: (args: string[]) => {
          staged = args[1]!.slice(0, -2)
          return { status: 7, stderr: 'copy failed' }
        },
      }),
    ).rejects.toThrow(/copy failed/u)
    await expect(stat(staged)).rejects.toThrow(/ENOENT/u)
  })

  it('rejects an escaping manifest path before Docker', async () => {
    const sourceRoot = await fixture()

    await expect(
      copyContainerSupport({
        container: 'runner',
        sourceRoot,
        manifest: [{ source: '../secret', target: 'secret', directory: false }],
        docker: () => {
          throw new Error('must not call Docker')
        },
      }),
    ).rejects.toThrow(/escapes its root/u)
  })
})
