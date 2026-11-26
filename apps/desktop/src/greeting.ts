import type { Greeting } from './bridge.js';
import { greetingPath, validGreetingName } from './sidecar-wire.js';

export function parseGreeting(reply: unknown): Greeting {
  if (
    !reply ||
    typeof reply !== 'object' ||
    !('message' in reply) ||
    typeof reply.message !== 'string' ||
    !reply.message
  ) {
    throw new Error('API returned an invalid greeting.');
  }
  return { message: reply.message };
}

export async function requestGreeting(
  target: string,
  name: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Greeting> {
  if (!validGreetingName(name)) {
    throw new Error('A name of at most 80 characters is required.');
  }
  const url = new URL(greetingPath, target);
  url.searchParams.set('name', name);
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`API request failed (${response.status}).`);
  }
  let reply: unknown;
  try {
    reply = await response.json();
  } catch {
    throw new Error('API returned invalid JSON.');
  }
  return parseGreeting(reply);
}
