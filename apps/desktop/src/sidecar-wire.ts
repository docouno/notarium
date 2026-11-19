export const greetingPath = '/api/greeting';
export const collabTicketPath = '/api/v1/auth/ws-ticket';
export const collabSubprotocol = 'notarium.collab.v1';
const ticketPattern = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const legacyId = '(?:[A-Za-z0-9_-]{12}|[0-9A-Fa-f]{16})';
const spaceId = new RegExp(`^(?:sp_[0-9a-f]{32}|${legacyId})$`);
const noteId = new RegExp(`^(?:nt_[0-9a-f]{32}|${legacyId})$`);

export interface CollabScope {
  spaceId: string;
  noteId: string;
}

export function collabPath(scope: CollabScope): string {
  if (!spaceId.test(scope.spaceId) || !noteId.test(scope.noteId)) {
    throw new Error('Invalid collaboration document identity.');
  }
  return `/api/v1/spaces/${scope.spaceId}/notes/${scope.noteId}/collab`;
}

export function isCollabPath(path: string): boolean {
  const match = /^\/api\/v1\/spaces\/([^/]+)\/notes\/([^/]+)\/collab$/.exec(path);
  return !!match && spaceId.test(match[1] ?? '') && noteId.test(match[2] ?? '');
}

export function isCollabTicket(value: unknown): value is string {
  return typeof value === 'string' && ticketPattern.test(value);
}

export function validGreetingName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 80;
}

export function webSocketOrigin(httpOrigin: string): string {
  return `ws://${new URL(httpOrigin).host}`;
}
