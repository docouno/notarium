import { expect, it } from 'vitest';
import { greet } from './api.js';
it('uses the specific desktop greeting bridge', async () => {
  let requested = '';
  await expect(
    greet('Ada', {
      getCapabilities: () => Promise.resolve({ apiEnabled: true }),
      greet: (name) => {
        requested = name;
        return Promise.resolve({ message: 'Hello, Ada!' });
      },
    }),
  ).resolves.toEqual({ message: 'Hello, Ada!' });
  expect(requested).toBe('Ada');
});
