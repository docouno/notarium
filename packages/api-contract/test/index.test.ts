import { expect, it } from 'vitest';
import { formatGreeting } from '../src/index.js';

it('formats greetings with trimmed subject and fallback', () => {
  expect(formatGreeting(' Ada ')).toEqual({ message: 'Hello, Ada!' });
  expect(formatGreeting('   ')).toEqual({ message: 'Hello, world!' });
  expect(formatGreeting()).toEqual({ message: 'Hello, world!' });
});
