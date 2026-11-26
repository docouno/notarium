// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { WebContents, WebFrameMain } from 'electron';
import { expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  createMainFrameGuard,
  expectedHttpMethod,
} from './renderer-session.js';

it('withdraws the frame privilege when an about:blank child can borrow its attribution', () => {
  const mainFrame = { url: 'app://local/index.html', parent: null, frames: [] as WebFrameMain[] };
  const primary = mainFrame as unknown as WebFrameMain;
  const child = { url: 'about:blank', parent: primary, frames: [] } as unknown as WebFrameMain;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: primary,
    isDestroyed: () => false,
  });
  const guard = createMainFrameGuard(contents as unknown as WebContents, mainFrame.url);
  contents.emit('frame-created', {}, { frame: primary });
  expect(guard(primary)).toBe(true);
  expect(guard(child)).toBe(false);
  mainFrame.frames.push(child);
  expect(guard(primary)).toBe(false);
  contents.emit('frame-created', {}, { frame: child });
  mainFrame.frames.length = 0;
  expect(guard(primary)).toBe(false);
});

it('permits only the selected sidecar port and the development HMR destination', () => {
  const endpoint = 'http://127.0.0.1:43981';
  const packaged = contentSecurityPolicy(undefined, endpoint);
  expect(packaged).toContain(`connect-src 'self' ${endpoint} ws://127.0.0.1:43981`);
  expect(packaged).toContain("script-src 'self';");
  expect(packaged).toContain("frame-src 'none';");
  expect(packaged).not.toContain('localhost');
  const development = contentSecurityPolicy(new URL('http://localhost:5173/'), endpoint);
  expect(development).toContain(
    `connect-src 'self' ws://localhost:5173 ${endpoint} ws://127.0.0.1:43981`,
  );
  expect(contentSecurityPolicy(undefined, undefined)).toContain("connect-src 'self'");
});

it('admits only the two scoped HTTP entry points', () => {
  const endpoint = 'http://127.0.0.1:43981';
  const method = (path: string) => expectedHttpMethod(new URL(path, endpoint));
  expect(method('/api/greeting?name=Ada+%26+Bob')).toBe('GET');
  expect(method('/api/greeting?name=')).toBe('GET');
  expect(method('/api/greeting')).toBeUndefined();
  expect(method('/api/greeting?name=Ada&name=Bob')).toBeUndefined();
  expect(method(`/api/greeting?name=${'A'.repeat(81)}`)).toBeUndefined();
  expect(method('/api/greeting?name=Ada&extra=true')).toBeUndefined();
  expect(method('/api/v1/auth/ws-ticket')).toBe('POST');
  expect(method('/api/v1/auth/ws-ticket?extra=true')).toBeUndefined();
  expect(method('/api/v1/arbitrary')).toBeUndefined();
});
