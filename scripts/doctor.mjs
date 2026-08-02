#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const PACKAGES = ['contract', 'core', 'desktop', 'engine', 'engine-memory', 'server', 'web']

const fail = (message) => {
  console.error(`doctor: ${message}`)
  process.exit(1)
}

const assert = (condition, message) => {
  if (!condition) {
    fail(message)
  }
}

const commandOk = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { stdio: 'pipe' })
  return result.status === 0
}

const assertCommand = (command, args = ['--version']) => {
  assert(commandOk(command, args), `missing or broken command: ${[command, ...args].join(' ')}`)
}

const checkWorkspaceLinks = (root) => {
  const tsc = join(root, 'node_modules', '.bin', 'tsc')
  assert(existsSync(tsc), `missing ${tsc}; run make deps`)

  for (const pkg of PACKAGES) {
    const link = join(root, 'node_modules', '@notarium', pkg)
    const expected = join(root, 'packages', pkg)
    assert(existsSync(link), `missing workspace link: ${link}`)
    assert(
      realpathSync(link) === expected,
      `workspace link ${link} points to ${realpathSync(link)}, expected ${expected}`,
    )
  }

  // The published CLI links under its bare product name, outside the scope.
  const cli = join(root, 'node_modules', 'notarium')
  const cliExpected = join(root, 'packages', 'cli')
  assert(existsSync(cli), `missing workspace link: ${cli}`)
  assert(
    realpathSync(cli) === cliExpected,
    `workspace link ${cli} points to ${realpathSync(cli)}, expected ${cliExpected}`,
  )
}

const checkContainer = () => {
  const root = '/app'
  assertCommand('ps', ['-o', 'pid=', '-p', String(process.pid)])
  checkWorkspaceLinks(root)

  const webDir = join(root, 'packages', 'web')
  const writableProbe = join(webDir, '.notarium-doctor.tmp')
  writeFileSync(writableProbe, 'ok\n')
  rmSync(writableProbe, { force: true })

  const requireFromWeb = createRequire(join(webDir, 'package.json'))
  const vitePath = requireFromWeb.resolve('vite/package.json')
  assert(
    vitePath.startsWith(join(root, 'node_modules') + '/'),
    `vite resolves from ${vitePath}, expected root /app/node_modules`,
  )

  console.log('doctor: container ok')
}

const checkHost = () => {
  const root = process.cwd()
  assertCommand('git')
  assertCommand('node')
  assertCommand('npm')
  assertCommand('docker', ['compose', 'version'])
  checkWorkspaceLinks(root)
  console.log('doctor: host ok')
}

const mode = process.argv[2] ?? 'host'

if (mode === 'host') {
  checkHost()
} else if (mode === 'container') {
  checkContainer()
} else {
  fail(`unknown mode: ${mode}`)
}
