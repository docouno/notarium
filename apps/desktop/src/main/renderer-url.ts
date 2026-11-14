export function isTrustedRendererURL(candidate: string, expected: string): boolean {
  try {
    const target = new URL(candidate);
    const renderer = new URL(expected);
    if (target.username || target.password) {
      return false;
    }
    if (renderer.protocol === 'http:') {
      return target.protocol === 'http:' && target.origin === renderer.origin;
    }
    return (
      renderer.protocol === 'app:' &&
      renderer.hostname === 'local' &&
      target.protocol === 'app:' &&
      target.hostname === 'local' &&
      target.port === ''
    );
  } catch {
    return false;
  }
}
