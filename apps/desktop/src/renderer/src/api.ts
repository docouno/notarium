import type { DesktopBridge, Greeting } from '../../bridge.js';
import { parseGreeting, requestGreeting } from '../../greeting.js';
import {
  collabPath,
  collabSubprotocol,
  collabTicketPath,
  isCollabTicket,
  webSocketOrigin,
  type CollabScope,
} from '../../sidecar-wire.js';

export async function greet(
  name: string,
  bridge: DesktopBridge = window.desktop,
  fetcher: typeof fetch = fetch,
): Promise<Greeting> {
  const { sidecarEndpoint } = await bridge.getCapabilities();
  if (sidecarEndpoint) {
    return requestGreeting(sidecarEndpoint, name, fetcher);
  }
  return parseGreeting(await bridge.greet(name));
}

export async function openSidecarCollab(
  scope: CollabScope,
  bridge: DesktopBridge = window.desktop,
  fetcher: typeof fetch = fetch,
  connect = (url: string, protocols: string[]) => new WebSocket(url, protocols),
): Promise<WebSocket> {
  const path = collabPath(scope);
  const { sidecarEndpoint } = await bridge.getCapabilities();
  if (!sidecarEndpoint) {
    throw new Error('The local sidecar is not available.');
  }
  const response = await fetcher(new URL(collabTicketPath, sidecarEndpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ space_id: scope.spaceId, note_id: scope.noteId }),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200) {
    throw new Error(`Could not authorize collaboration (${response.status}).`);
  }
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== 'object' ||
    !('ticket' in value && isCollabTicket(value.ticket)) ||
    !('expires_in' in value && value.expires_in === 30)
  ) {
    throw new Error('The sidecar returned an invalid collaboration ticket.');
  }
  return connect(`${webSocketOrigin(sidecarEndpoint)}${path}`, [
    collabSubprotocol,
    `notarium.ticket.${value.ticket}`,
  ]);
}
