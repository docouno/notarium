export function parseComposeTarget(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const url = URL.parse(value);
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error('DEVKIT_API_TARGET must be an HTTP(S) origin without credentials.');
  }
  return url.origin;
}
