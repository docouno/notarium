import type { Greeting } from '@notarium/package-api-contract';

export async function greet(name: string, fetcher: typeof fetch = fetch): Promise<Greeting> {
  const query = new URLSearchParams({ name });
  const response = await fetcher(`/api/greeting?${query.toString()}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`API request failed (${response.status}).`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('API returned invalid JSON.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('message' in value) ||
    typeof value.message !== 'string' ||
    !value.message
  ) {
    throw new Error('API returned an invalid greeting.');
  }
  return { message: value.message };
}
