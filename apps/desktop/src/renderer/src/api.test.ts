import { expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../bridge.js';
import { greet, openSidecarCollab } from './api.js';
it('uses the specific desktop greeting bridge', async () => {
  let requested = '';
  await expect(
    greet('Ada', {
      getCapabilities: () => Promise.resolve({ apiEnabled: true }),
      greet: (name) => {
        requested = name;
        return Promise.resolve({ message: 'Hello, Ada!' });
      },
    }),
  ).resolves.toEqual({ message: 'Hello, Ada!' });
  expect(requested).toBe('Ada');
});

const sidecarEndpoint = 'http://127.0.0.1:43981';
const scope = {
  spaceId: `sp_${'a'.repeat(32)}`,
  noteId: `nt_${'b'.repeat(32)}`,
};

function nativeBridge(): DesktopBridge {
  return {
    getCapabilities: () => Promise.resolve({ apiEnabled: true, sidecarEndpoint }),
    greet: () => Promise.reject(new Error('Unexpected fallback to Compose.')),
  };
}

it('requests the native greeting from the renderer with no exposed bearer', async () => {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('{"message":"Hello, Ada!"}')),
  );
  await expect(greet('Ada', nativeBridge(), fetcher)).resolves.toEqual({ message: 'Hello, Ada!' });
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    new URL(`${sidecarEndpoint}/api/greeting?name=Ada`),
    {
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    },
  );
});

it('presents the short-lived ticket only in the WebSocket protocols', async () => {
  const ticket = 'A'.repeat(22);
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({ ticket, expires_in: 30 }))),
  );
  const socket = new EventTarget() as WebSocket;
  const connect = vi.fn(() => socket);
  await expect(openSidecarCollab(scope, nativeBridge(), fetcher, connect)).resolves.toBe(socket);
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    new URL(`${sidecarEndpoint}/api/v1/auth/ws-ticket`),
    {
      body: JSON.stringify({ space_id: scope.spaceId, note_id: scope.noteId }),
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal,
    },
  );
  expect(connect).toHaveBeenCalledExactlyOnceWith(
    `ws://127.0.0.1:43981/api/v1/spaces/${scope.spaceId}/notes/${scope.noteId}/collab`,
    ['notarium.collab.v1', `notarium.ticket.${ticket}`],
  );
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ ticket: 'x'.repeat(22), expires_in: 30 })),
  );
  await expect(openSidecarCollab(scope, nativeBridge(), fetcher, connect)).rejects.toThrow(
    'invalid collaboration ticket',
  );
  expect(connect).toHaveBeenCalledTimes(1);
});
