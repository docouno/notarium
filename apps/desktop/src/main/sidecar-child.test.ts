// @vitest-environment node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parseReadyLine, sidecarExecutable, supervise } from './sidecar-child.js';

it('selects the deployment resource or a repository-local native profile', () => {
  const base = { resourcesPath: '/desktop/resources', appPath: '/repo/apps/desktop' };
  expect(
    sidecarExecutable({ ...base, packaged: true, platform: 'win32', profile: 'unrelated' }),
  ).toBe(resolve('/desktop/resources/notarium-sidecar.exe'));
  expect(sidecarExecutable({ ...base, packaged: false, platform: 'linux' })).toBe(
    resolve('/repo/apps/api/target/debug/notarium-sidecar'),
  );
  expect(
    sidecarExecutable({ ...base, packaged: false, platform: 'win32', profile: 'release' }),
  ).toBe(resolve('/repo/apps/api/target/release/notarium-sidecar.exe'));
  expect(() =>
    sidecarExecutable({ ...base, packaged: false, platform: 'linux', profile: '../custom' }),
  ).toThrow('profile');
});

it('checks the bounded frame, process identity and exact loopback address', () => {
  const ready = {
    schemaVersion: 1,
    status: 'ready',
    port: 49619,
    baseUrl: 'http://127.0.0.1:49619',
    pid: 42,
  };
  const encode = (value: object) => Buffer.from(JSON.stringify(value));
  expect(parseReadyLine(encode(ready), 42)).toBe(ready.baseUrl);
  for (const changed of [
    { port: 65536 },
    { port: 3.1 },
    { port: 0 },
    { status: 'starting' },
    { schemaVersion: 2 },
    { pid: 41 },
    { pid: '42' },
    { baseUrl: 'http://127.0.0.1:49619/' },
    { baseUrl: 'http://127.0.0.1:49619?query' },
    { baseUrl: 'http://localhost:49619' },
    { baseUrl: 'http://user@127.0.0.1:49619' },
    { junk: 'x'.repeat(4096) },
  ]) {
    expect(() => parseReadyLine(encode({ ...ready, ...changed }), 42)).toThrow('readiness');
  }
  expect(() => parseReadyLine(Buffer.from([0xff]), 42)).toThrow('readiness');
});

const childProgram = `
  const readline = require('node:readline');
  const mode = process.argv[1];
  const reader = readline.createInterface({ input: process.stdin });
  const keepAlive = mode === 'hang' || mode === 'malformed' || mode === 'startup-timeout';
  if (keepAlive) setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {});
  reader.once('line', (line) => {
    const { token } = JSON.parse(line);
    if (Buffer.from(token, 'base64url').length !== 32 || process.argv.includes(token) || Object.values(process.env).includes(token)) {
      process.exit(4);
    }
    if (mode === 'startup-timeout') return;
    if (mode === 'early-exit') return process.exit(5);
    if (mode === 'malformed') return process.stdout.write('x'.repeat(4097));
    const ready = JSON.stringify({ schemaVersion: 1, status: 'ready', pid: process.pid, port: 43981, baseUrl: 'http://127.0.0.1:43981' });
    process.stdout.write(ready.slice(0, 11));
    setImmediate(() => process.stdout.write(ready.slice(11) + '\\n'));
  });
`;

function start(mode: string, startupTimeout = 2000) {
  const child = spawn(process.execPath, ['-e', childProgram, mode], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const token = Buffer.alloc(32, 17);
  // The Windows supervisor closes stdin for a graceful stop without sending a signal.
  const sidecar = supervise(child, token, 'win32', startupTimeout, 250);
  return { child, sidecar, token };
}

it('retains the launch pipe, then waits for a single graceful EOF shutdown', async () => {
  const { child, sidecar, token } = start('healthy');
  try {
    const endpoint = await sidecar.ready;
    expect(child.stdin.destroyed).toBe(false);
    expect(sidecar.connection()).toEqual({
      endpoint,
      authorization: `Bearer ${token.toString('base64url')}`,
    });
    const stopping = sidecar.stop();
    expect(sidecar.stop()).toBe(stopping);
    expect(sidecar.connection()).toBeUndefined();
    await stopping;
    expect(child.exitCode).toBe(0);
    expect(token.every((byte) => byte === 0)).toBe(true);
  } finally {
    await sidecar.stop();
  }
});

it('withdraws access and waits for forced termination after the grace period', async () => {
  const { child, sidecar } = start('hang');
  try {
    await sidecar.ready;
    await sidecar.stop();
    expect(sidecar.connection()).toBeUndefined();
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    await sidecar.stop();
  }
});

it.each([
  ['malformed', 'readiness'],
  ['early-exit', 'readiness'],
  ['startup-timeout', 'timed out'],
])('reaps a failed startup (%s)', async (mode, message) => {
  const { child, sidecar } = start(mode, mode === 'startup-timeout' ? 275 : 2000);
  try {
    await expect(sidecar.ready).rejects.toThrow(message);
  } finally {
    await sidecar.stop();
  }
  expect(sidecar.connection()).toBeUndefined();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it('revokes the endpoint on an unexpected child exit after startup', async () => {
  const { child, sidecar } = start('healthy');
  try {
    await sidecar.ready;
    expect(sidecar.connection()).toBeDefined();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    expect(sidecar.connection()).toBeUndefined();
  } finally {
    await sidecar.stop();
  }
});
