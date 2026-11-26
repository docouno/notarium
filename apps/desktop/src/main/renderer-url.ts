import type { SidecarOrigin } from './sidecar-child.js';

const appOrigin = 'app://local';
const nativeDevelopmentOrigin = 'http://localhost:5173';

export function selectRenderer(
  packaged: boolean,
  devURL: string | undefined,
  compose: boolean,
): {
  url: string;
  development: URL | undefined;
  nativeOrigin: SidecarOrigin;
} {
  if (packaged || devURL === undefined) {
    return { url: `${appOrigin}/index.html`, development: undefined, nativeOrigin: appOrigin };
  }
  const development = URL.parse(devURL);
  if (
    !development ||
    development.protocol !== 'http:' ||
    development.username ||
    development.password ||
    !['localhost', '127.0.0.1', '[::1]'].includes(development.hostname)
  ) {
    throw new Error('Development requires a local HTTP renderer origin.');
  }
  if (!compose && development.origin !== nativeDevelopmentOrigin) {
    throw new Error('Native development requires the http://localhost:5173 renderer origin.');
  }
  return { url: development.href, development, nativeOrigin: nativeDevelopmentOrigin };
}

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
