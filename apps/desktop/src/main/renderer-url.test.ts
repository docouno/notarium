import { expect, it } from 'vitest';
import { isTrustedRendererURL, selectRenderer } from './renderer-url.js';
it('matches the exact development origin rather than a port prefix', () => {
  expect(isTrustedRendererURL('http://localhost:5173/page', 'http://localhost:5173')).toBe(true);
  expect(isTrustedRendererURL('http://localhost:51730/page', 'http://localhost:5173')).toBe(false);
  expect(isTrustedRendererURL('http://localhost.example:5173/page', 'http://localhost:5173')).toBe(
    false,
  );
});

it('chooses a single native origin and ignores the development URL in packaged mode', () => {
  expect(selectRenderer(true, 'http://127.0.0.1:5173', false)).toEqual({
    url: 'app://local/index.html',
    development: undefined,
    nativeOrigin: 'app://local',
  });
  expect(selectRenderer(false, 'http://localhost:5173', false).nativeOrigin).toBe(
    'http://localhost:5173',
  );
  expect(() => selectRenderer(false, 'http://127.0.0.1:5173', false)).toThrow('Native development');
  expect(selectRenderer(false, 'http://127.0.0.1:5174', true).url).toBe('http://127.0.0.1:5174/');
  expect(() => selectRenderer(false, 'http://other.example:5173', true)).toThrow('local HTTP');
});
it('matches only the local application scheme and host', () => {
  expect(isTrustedRendererURL('app://local/index.html', 'app://local/index.html')).toBe(true);
  expect(isTrustedRendererURL('app://local.example/index.html', 'app://local/index.html')).toBe(
    false,
  );
  expect(isTrustedRendererURL('app://local:9999/index.html', 'app://local/index.html')).toBe(false);
  expect(isTrustedRendererURL('app://user@local/index.html', 'app://local/index.html')).toBe(false);
  expect(isTrustedRendererURL('not a URL', 'app://local/index.html')).toBe(false);
});
