import { expect, it } from 'vitest';
import { isTrustedRendererURL } from './renderer-url.js';
it('matches the exact development origin rather than a port prefix', () => {
  expect(isTrustedRendererURL('http://localhost:5173/page', 'http://localhost:5173')).toBe(true);
  expect(isTrustedRendererURL('http://localhost:51730/page', 'http://localhost:5173')).toBe(false);
  expect(isTrustedRendererURL('http://localhost.example:5173/page', 'http://localhost:5173')).toBe(
    false,
  );
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
