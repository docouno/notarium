import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join, resolve } from 'node:path';
import type { DesktopCapabilities } from '../bridge.js';
import { requestGreeting } from '../greeting.js';
import { parseComposeTarget } from './api.js';
import {
  contentSecurityPolicy,
  createMainFrameGuard,
  installRendererAccess,
  registerRendererProtocol,
} from './renderer-session.js';
import { selectRenderer, isTrustedRendererURL } from './renderer-url.js';
import { launchSidecar, sidecarExecutable, type SidecarChild } from './sidecar-child.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let sidecar: SidecarChild | undefined;
let quitting = false;
let shutdownComplete = false;

function exitWithError(error: unknown): void {
  console.error(error instanceof Error ? error.message : 'Desktop initialization failed.');
  shutdownComplete = true;
  app.exit(1);
}

async function createWindow(): Promise<void> {
  const target = parseComposeTarget(process.env.DEVKIT_API_TARGET);
  const {
    url: rendererURL,
    development,
    nativeOrigin,
  } = selectRenderer(app.isPackaged, process.env.ELECTRON_RENDERER_URL, target !== undefined);
  const appSession = session.fromPartition('notarium-desktop', { cache: false });
  await appSession.setProxy({ mode: 'direct' });
  let endpoint: string | undefined;
  if (!target) {
    const executable = sidecarExecutable({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      platform: process.platform,
      profile: process.env.NOTARIUM_SIDECAR_PROFILE ?? 'debug',
    });
    sidecar = launchSidecar(executable, nativeOrigin);
    endpoint = await sidecar.ready;
  }

  const policy = contentSecurityPolicy(development, endpoint);
  if (!development) {
    await registerRendererProtocol(appSession, resolve(import.meta.dirname, '../renderer'), policy);
  }
  if (quitting) {
    return;
  }
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    webPreferences: {
      session: appSession,
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const contents = window.webContents;
  const trustedMainFrame = createMainFrameGuard(contents, rendererURL);
  installRendererAccess(appSession, {
    contents,
    trustedMainFrame,
    rendererURL,
    development,
    endpoint,
    sidecar,
    policy,
  });

  function assertSender(event: IpcMainInvokeEvent): void {
    if (event.sender !== contents || !trustedMainFrame(event.senderFrame)) {
      throw new Error('Untrusted renderer.');
    }
  }
  ipcMain.handle('desktop:capabilities', (event): DesktopCapabilities => {
    assertSender(event);
    const connection = sidecar?.connection();
    return connection
      ? { apiEnabled: true, sidecarEndpoint: connection.endpoint }
      : { apiEnabled: target !== undefined };
  });
  ipcMain.handle('desktop:greet', (event, name: unknown) => {
    assertSender(event);
    if (!target) {
      throw new Error('The Compose API is not configured.');
    }
    return requestGreeting(target, name);
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isTrustedRendererURL(event.url, rendererURL)) {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  await window.loadURL(rendererURL);
}

app.on('before-quit', (event) => {
  if (shutdownComplete || !sidecar) {
    return;
  }
  event.preventDefault();
  if (quitting) {
    return;
  }
  quitting = true;
  sidecar.stop().then(({ code, signal }) => {
    if (code !== 0) {
      exitWithError(new Error(`Sidecar shutdown ended with ${signal ?? `exit code ${code}`}.`));
      return;
    }
    shutdownComplete = true;
    app.quit();
  }, exitWithError);
});

app
  .whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    if (quitting) {
      return;
    }
    const cleanup = sidecar?.stop() ?? Promise.resolve();
    cleanup.then(() => exitWithError(error), exitWithError);
  });
app.on('window-all-closed', () => app.quit());
