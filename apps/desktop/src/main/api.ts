import type { Greeting } from '../bridge.js';
export async function requestGreeting(
  target: string,
  name: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Greeting> {
  if (typeof name !== 'string' || name.length > 80) {
    throw new Error('A name of at most 80 characters is required.');
  }
  const url = new URL('/api/greeting', target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid API target.');
  }
  url.searchParams.set('name', name);
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
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
