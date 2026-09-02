#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PLAYWRIGHT = 'node_modules/@playwright/test/cli.js'
const VISUAL_BASELINE = 'scripts/visualBaseline.mjs'

/** @typedef {{ status?: number | null, signal?: NodeJS.Signals | null, error?: Error }} CommandResult */
/** @typedef {{ command?: string, args: string[], cwd: string, env: NodeJS.ProcessEnv }} CommandOptions */

/** @type {(options: CommandOptions) => CommandResult} */
const defaultRun = ({ command = process.execPath, args, cwd, env }) =>
  spawnSync(command, args, { cwd, env, stdio: 'inherit' })

const resultError = (result, label) => {
  if (result.error) {
    return `${label}: ${result.error.message}`
  }
  if (result.signal) {
    return `${label}: terminated by ${result.signal}`
  }
  if (result.status !== 0) {
    return `${label}: exited ${result.status}`
  }

  return null
}

const requireSuccess = (result, label) => {
  const error = resultError(result, label)

  if (error) {
    throw new Error(error)
  }
}

const credentialEnv = (env, mode) => ({
  ...env,
  VISUAL_S3_KEY_ID: mode === 'write' ? env.VISUAL_S3_WRITE_KEY_ID : env.VISUAL_S3_READ_KEY_ID,
  VISUAL_S3_SECRET: mode === 'write' ? env.VISUAL_S3_WRITE_SECRET : env.VISUAL_S3_READ_SECRET,
})

const publishing = (env) =>
  Boolean(
    env.CI_COMMIT_BRANCH &&
    env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH &&
    env.VISUAL_S3_WRITE_KEY_ID &&
    env.VISUAL_S3_WRITE_SECRET,
  )

const required = (env, name) => {
  const value = env[name]

  if (!value) {
    throw new Error(`CI visual producer requires ${name}`)
  }

  return value
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, run?: (options: CommandOptions) => CommandResult }} [options]
 */
export const runCiVisual = ({ cwd = process.cwd(), env = process.env, run = defaultRun } = {}) => {
  requireSuccess(
    run({
      args: [VISUAL_BASELINE, 'pull'],
      cwd,
      env: credentialEnv(env, 'read'),
    }),
    'visual baseline pull',
  )

  const visual = run({
    args: ['--no-maglev', PLAYWRIGHT, 'test', 'test/visual', '--workers=1', '--reporter=list,json'],
    cwd,
    env,
  })
  const publish = publishing(env)
  const protocolArgs = publish
    ? [
        VISUAL_BASELINE,
        'publish',
        '--candidate',
        `${required(env, 'CI_COMMIT_REF_SLUG')}-${required(env, 'CI_COMMIT_SHORT_SHA')}-${required(env, 'CI_PIPELINE_ID')}-${required(env, 'CI_JOB_ID')}`,
        '--commit',
        required(env, 'CI_COMMIT_SHA'),
        '--pipeline',
        required(env, 'CI_PIPELINE_ID'),
        '--job',
        required(env, 'CI_JOB_ID'),
      ]
    : [VISUAL_BASELINE, 'verdict']

  if (!publish) {
    console.error('visual: comparison-only ref or no writer credentials — no candidate')
  }
  const protocol = run({
    args: protocolArgs,
    cwd,
    env: credentialEnv(env, publish ? 'write' : 'read'),
  })

  return {
    exitCode: protocol.status ?? 1,
    signal: protocol.signal ?? null,
    visualExitCode: visual.status ?? 1,
    visualSignal: visual.signal ?? null,
    mode: publish ? 'publish' : 'verdict',
  }
}

const main = () => {
  const result = runCiVisual()

  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.exitCode
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
