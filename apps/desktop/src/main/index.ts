import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestGreeting } from './api.js';
import { isTrustedRendererURL } from './renderer-url.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const rendererRoot = resolve(import.meta.dirname, '../renderer');
const development =
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL)
    : undefined;
if (
  development &&
  (development.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(development.hostname) ||
    development.username ||
    development.password)
) {
  throw new Error('Development requires a local HTTP renderer origin.');
}
const rendererURL = development?.href ?? 'app://local/index.html';
const apiTarget = process.env.DEVKIT_API_TARGET;

function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + sep);
}

async function createWindow(): Promise<void> {
  const root = await realpath(rendererRoot);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (
      url.protocol !== 'app:' ||
      url.hostname !== 'local' ||
      url.port ||
      url.username ||
      url.password
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    try {
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = resolve(root, '.' + relative);
      if (!inside(root, file)) {
        return new Response('Forbidden', { status: 403 });
      }
      const actual = await realpath(file);
      if (!inside(root, actual) || !(await stat(actual)).isFile()) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(actual).href);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  function assertSender(event: IpcMainInvokeEvent): void {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedRendererURL(event.senderFrame.url, rendererURL)
    ) {
      throw new Error('Untrusted renderer.');
    }
  }
  ipcMain.handle('desktop:capabilities', (event) => {
    assertSender(event);
    return { apiEnabled: Boolean(apiTarget) };
  });
  ipcMain.handle('desktop:greet', (event, name: unknown) => {
    assertSender(event);
    if (!apiTarget) {
      throw new Error('No API is configured.');
    }
    return requestGreeting(apiTarget, name);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererURL(url, rendererURL)) {
      event.preventDefault();
    }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  await window.loadURL(rendererURL);
}

app
  .whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
