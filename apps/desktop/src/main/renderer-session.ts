import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Session, WebContents, WebFrameMain } from 'electron';
import {
  collabTicketPath,
  greetingPath,
  isCollabPath,
  validGreetingName,
  webSocketOrigin,
} from '../sidecar-wire.js';
import { isTrustedRendererURL } from './renderer-url.js';
import type { SidecarChild } from './sidecar-child.js';

function within(root: string, file: string): boolean {
  return file === root || file.startsWith(root + sep);
}

type MainFrameGuard = (frame: WebFrameMain | null | undefined) => boolean;

export function createMainFrameGuard(contents: WebContents, rendererURL: string): MainFrameGuard {
  // An initial about:blank subframe can inherit the main frame's network attribution.
  // Keep the window untrusted once a subframe appears, including after removal.
  let subframeSeen = false;
  contents.on('frame-created', (_event, { frame }) => {
    if (frame?.parent !== null) {
      subframeSeen = true;
    }
  });
  return (frame) => {
    if (subframeSeen || !frame || contents.isDestroyed()) {
      return false;
    }
    try {
      return (
        frame === contents.mainFrame &&
        frame.frames.length === 0 &&
        isTrustedRendererURL(frame.url, rendererURL)
      );
    } catch {
      // The request can outlive the renderer process.
      return false;
    }
  };
}

export function contentSecurityPolicy(
  development: URL | undefined,
  endpoint: string | undefined,
): string {
  const destinations = ["'self'"];
  if (development) {
    destinations.push(webSocketOrigin(development.origin));
  }
  if (endpoint) {
    destinations.push(endpoint, webSocketOrigin(endpoint));
  }
  return [
    "default-src 'self'",
    development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `connect-src ${destinations.join(' ')}`,
  ].join('; ');
}

export async function registerRendererProtocol(
  session: Session,
  rendererRoot: string,
  policy: string,
): Promise<void> {
  const root = await realpath(rendererRoot);
  session.protocol.handle('app', async (request) => {
    if (!isTrustedRendererURL(request.url, 'app://local')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    try {
      const path = new URL(request.url).pathname;
      const relative = decodeURIComponent(path === '/' ? '/index.html' : path);
      const file = resolve(root, '.' + relative);
      if (!within(root, file)) {
        return new Response('Forbidden', { status: 403 });
      }
      const actual = await realpath(file);
      if (!within(root, actual) || !(await stat(actual)).isFile()) {
        return new Response('Forbidden', { status: 403 });
      }
      const result = await session.fetch(pathToFileURL(actual).href, { method: request.method });
      const headers = new Headers(result.headers);
      if (actual.endsWith('.html')) {
        headers.set('Content-Security-Policy', policy);
      }
      return new Response(result.body, { headers, status: result.status });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export function expectedHttpMethod(url: URL): 'GET' | 'POST' | undefined {
  if (url.username || url.password || url.hash) {
    return undefined;
  }
  if (url.pathname === greetingPath) {
    const [[key, name] = [], ...extra] = Array.from(url.searchParams);
    if (key === 'name' && extra.length === 0 && validGreetingName(name)) {
      return 'GET';
    }
  }
  if (url.pathname === collabTicketPath && !url.search) {
    return 'POST';
  }
  return undefined;
}

function singleHeader(headers: Record<string, string>, name: string): string | undefined {
  const matching = Object.keys(headers).filter((key) => key.toLowerCase() === name);
  return matching.length === 1 && matching[0] !== undefined ? headers[matching[0]] : undefined;
}

interface SessionAccess {
  contents: WebContents;
  trustedMainFrame: MainFrameGuard;
  rendererURL: string;
  development: URL | undefined;
  endpoint: string | undefined;
  sidecar: SidecarChild | undefined;
  policy: string;
}

export function installRendererAccess(
  session: Session,
  {
    contents,
    trustedMainFrame,
    rendererURL,
    development,
    endpoint,
    sidecar,
    policy,
  }: SessionAccess,
): void {
  const rendererOrigin = development?.origin ?? 'app://local';
  const hmrOrigin = development ? webSocketOrigin(development.origin) : undefined;
  const socketOrigin = endpoint ? webSocketOrigin(endpoint) : undefined;
  const network = session.webRequest;

  network.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      callback({});
      return;
    }
    if (url.origin === development?.origin || url.origin === hmrOrigin) {
      callback({});
      return;
    }
    callback({
      cancel:
        (url.origin !== endpoint && url.origin !== socketOrigin) ||
        !sidecar?.connection() ||
        details.initiatorOrigin !== rendererOrigin,
    });
  });

  network.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);
    if (url.origin !== endpoint && url.origin !== socketOrigin) {
      callback({});
      return;
    }
    const connection = sidecar?.connection();
    const headers = details.requestHeaders;
    if (
      !connection ||
      connection.endpoint !== endpoint ||
      details.initiatorOrigin !== rendererOrigin ||
      singleHeader(headers, 'origin') !== rendererOrigin ||
      Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
    ) {
      callback({ cancel: true });
      return;
    }
    const method = expectedHttpMethod(url);
    if (details.method === 'OPTIONS') {
      callback({
        cancel:
          url.protocol !== 'http:' ||
          !method ||
          singleHeader(headers, 'access-control-request-method') !== method,
      });
      return;
    }
    if (details.webContentsId !== contents.id || !trustedMainFrame(details.frame)) {
      callback({ cancel: true });
      return;
    }
    if (url.protocol === 'ws:') {
      // Electron 45 omits Sec-WebSocket-Protocol from this callback.
      // The sidecar checks the subprotocols and consumes the ticket at upgrade.
      callback({
        cancel:
          details.resourceType !== 'webSocket' ||
          details.method !== 'GET' ||
          !!(url.username || url.password || url.search || url.hash) ||
          !isCollabPath(url.pathname),
      });
      return;
    }
    if (!method || details.method !== method || details.resourceType !== 'xhr') {
      callback({ cancel: true });
      return;
    }
    callback({ requestHeaders: { ...headers, Authorization: connection.authorization } });
  });

  network.onHeadersReceived((details, callback) => {
    // A redirect can carry the header already inserted for a previous hop.
    if (details.statusCode >= 300 && details.statusCode < 400 && details.statusCode !== 304) {
      callback({ cancel: true });
      return;
    }
    if (
      development &&
      details.resourceType === 'mainFrame' &&
      isTrustedRendererURL(details.url, rendererURL)
    ) {
      const responseHeaders = { ...details.responseHeaders };
      for (const name of Object.keys(responseHeaders)) {
        if (name.toLowerCase() === 'content-security-policy') {
          delete responseHeaders[name];
        }
      }
      callback({ responseHeaders: { ...responseHeaders, 'Content-Security-Policy': [policy] } });
      return;
    }
    callback({});
  });

  function allowLoopback(
    candidate: WebContents | null,
    permission: string,
    mainFrame: boolean,
    origin: string | undefined,
  ): boolean {
    return (
      permission === 'loopback-network' &&
      !!sidecar?.connection() &&
      candidate === contents &&
      mainFrame &&
      origin !== undefined &&
      isTrustedRendererURL(origin, rendererURL) &&
      trustedMainFrame(contents.mainFrame)
    );
  }

  session.setPermissionCheckHandler((candidate, permission, requestingOrigin, details) =>
    allowLoopback(candidate, permission, details.isMainFrame, requestingOrigin),
  );
  session.setPermissionRequestHandler((candidate, permission, callback, details) =>
    callback(allowLoopback(candidate, permission, details.isMainFrame, details.requestingUrl)),
  );
}
