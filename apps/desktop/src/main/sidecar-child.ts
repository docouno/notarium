import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

const STARTUP_TIMEOUT = 10_000;
const SHUTDOWN_TIMEOUT = 3_000;
const MAX_READY_LINE = 4_096;

export type SidecarOrigin = 'app://local' | 'http://localhost:5173';
type SidecarProcess = ChildProcessByStdio<Writable, Readable, null>;

export function sidecarExecutable({
  packaged,
  resourcesPath,
  appPath,
  platform,
  profile = 'debug',
}: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: NodeJS.Platform;
  profile?: string;
}): string {
  const name = platform === 'win32' ? 'notarium-sidecar.exe' : 'notarium-sidecar';
  if (packaged) {
    return resolve(resourcesPath, name);
  }
  if (profile !== 'debug' && profile !== 'release') {
    throw new Error('Invalid native sidecar build profile.');
  }
  return resolve(appPath, '../api/target', profile, name);
}

export function parseReadyLine(line: Uint8Array, pid: number | undefined): string {
  let value: unknown;
  try {
    if (line.length >= MAX_READY_LINE) {
      throw new Error();
    }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line));
  } catch {
    throw new Error('Invalid sidecar readiness frame.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value && value.schemaVersion === 1) ||
    !('status' in value && value.status === 'ready') ||
    !('pid' in value && pid !== undefined && value.pid === pid) ||
    !('port' in value && typeof value.port === 'number') ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  ) {
    throw new Error('Invalid sidecar readiness frame.');
  }
  const endpoint = `http://127.0.0.1:${value.port}`;
  if (!('baseUrl' in value) || value.baseUrl !== endpoint) {
    throw new Error('Invalid sidecar readiness endpoint.');
  }
  return endpoint;
}

export interface SidecarConnection {
  endpoint: string;
  authorization: string;
}

interface SidecarExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SidecarChild {
  readonly ready: Promise<string>;
  connection(): SidecarConnection | undefined;
  stop(): Promise<SidecarExit>;
}

export function launchSidecar(executable: string, origin: SidecarOrigin): SidecarChild {
  const token = randomBytes(32);
  const child = spawn(executable, ['--token-stdin', '--allowed-origin', origin], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  return supervise(child, token, process.platform, STARTUP_TIMEOUT, SHUTDOWN_TIMEOUT);
}

export function supervise(
  child: SidecarProcess,
  token: Buffer,
  platform: NodeJS.Platform,
  startupTimeout: number,
  shutdownTimeout: number,
): SidecarChild {
  let endpoint: string | undefined;
  let stopping: Promise<SidecarExit> | undefined;
  let exited = false;
  let receivedFrame = false;
  let frame = Buffer.alloc(0);
  let resolveReady!: (address: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<SidecarExit>((resolve) => {
    child.once('close', (code, signal) => {
      exited = true;
      revoke();
      clearTimeout(startupTimer);
      rejectReady(new Error('Sidecar closed before reporting readiness.'));
      resolve({ code, signal });
    });
  });

  function revoke() {
    endpoint = undefined;
    token.fill(0);
  }

  function running() {
    return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  }

  function stop(): Promise<SidecarExit> {
    revoke();
    clearTimeout(startupTimer);
    rejectReady(new Error('Sidecar stopped before becoming ready.'));
    return (stopping ??= (async () => {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      if (running() && platform !== 'win32') {
        child.kill('SIGTERM');
      }
      const deadline = setTimeout(() => {
        if (running()) {
          child.kill('SIGKILL');
        }
      }, shutdownTimeout);
      try {
        return await closed;
      } finally {
        clearTimeout(deadline);
      }
    })());
  }

  function fail(error: Error) {
    rejectReady(error);
    stop().catch(() => console.error('Could not terminate the sidecar process.'));
  }

  const startupTimer = setTimeout(
    () => fail(new Error('Sidecar startup timed out.')),
    startupTimeout,
  );
  child.on('error', () => fail(new Error('Sidecar process failed.')));
  child.stdin.on('error', () => fail(new Error('Sidecar startup pipe failed.')));
  child.stdout.on('error', () => fail(new Error('Sidecar readiness pipe failed.')));
  child.stdout.once('end', () => {
    if (!receivedFrame) {
      fail(new Error('Sidecar closed stdout before reporting readiness.'));
    }
  });
  child.once('exit', () => {
    exited = true;
    revoke();
    clearTimeout(startupTimer);
    rejectReady(new Error('Sidecar exited before reporting readiness.'));
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopping || exited) {
      return;
    }
    const newline = chunk.indexOf(10);
    if (
      receivedFrame ||
      frame.length + chunk.length > MAX_READY_LINE ||
      (newline !== -1 && newline !== chunk.length - 1)
    ) {
      fail(new Error('Invalid sidecar readiness frame.'));
      return;
    }
    frame = Buffer.concat([frame, newline < 0 ? chunk : chunk.subarray(0, newline)]);
    if (newline < 0) {
      return;
    }
    try {
      endpoint = parseReadyLine(frame, child.pid);
    } catch {
      fail(new Error('Invalid sidecar readiness frame.'));
      return;
    }
    frame = Buffer.alloc(0);
    receivedFrame = true;
    clearTimeout(startupTimer);
    resolveReady(endpoint);
  });

  child.stdin.write(`${JSON.stringify({ token: token.toString('base64url') })}\n`);
  return {
    ready,
    connection() {
      return endpoint && !exited && running()
        ? { endpoint, authorization: `Bearer ${token.toString('base64url')}` }
        : undefined;
    },
    stop,
  };
}
