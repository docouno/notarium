import { expect, it } from 'vitest';
import { greet } from './api.js';

it('encodes the greeting request and validates the response', async () => {
  let requested = '';
  const fetcher: typeof fetch = (input) => {
    requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(new Response(JSON.stringify({ message: 'Hello, Ada & Bob!' })));
  };
  await expect(greet('Ada & Bob', fetcher)).resolves.toEqual({ message: 'Hello, Ada & Bob!' });
  expect(requested).toBe('/api/greeting?name=Ada+%26+Bob');
});

it('rejects HTTP and malformed response failures', async () => {
  await expect(
    greet('Ada', () => Promise.resolve(new Response('down', { status: 503 }))),
  ).rejects.toThrow('503');
  await expect(greet('Ada', () => Promise.resolve(new Response('<html>')))).rejects.toThrow(
    'invalid JSON',
  );
  await expect(greet('Ada', () => Promise.resolve(new Response('{"message":42}')))).rejects.toThrow(
    'invalid greeting',
  );
});
