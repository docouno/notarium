import { expect, it } from 'vitest';
import { requestGreeting } from './api.js';
it('uses the configured backend and encodes the name', async () => {
  let requested = '';
  const fetcher: typeof fetch = (input) => {
    requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(new Response('{"message":"Hello!"}'));
  };
  await expect(requestGreeting('http://api:8080', 'Ada & Bob', fetcher)).resolves.toEqual({
    message: 'Hello!',
  });
  expect(requested).toBe('http://api:8080/api/greeting?name=Ada+%26+Bob');
});
it('rejects invalid names and backend failures', async () => {
  await expect(requestGreeting('http://api:8080', 42)).rejects.toThrow('name');
  await expect(
    requestGreeting('http://api:8080', 'Ada', () =>
      Promise.resolve(new Response('down', { status: 503 })),
    ),
  ).rejects.toThrow('503');
  await expect(
    requestGreeting('http://api:8080', 'Ada', () =>
      Promise.resolve(new Response('{"message":42}')),
    ),
  ).rejects.toThrow('invalid greeting');
});
