import { decodeUtf8Base64Url, encodeUtf8Base64Url } from '../libs/base64url'
import { isDurableScalar } from '../libs/id'

export type ImportSourceLocator =
  | { version: 'v1'; provider: 'claude'; kind: 'conversation'; ids: [string] }
  | { version: 'v1'; provider: 'claude'; kind: 'project-prompt'; ids: [string] }
  | { version: 'v1'; provider: 'claude'; kind: 'project-doc'; ids: [string, string] }
  | { version: 'v1'; provider: 'claude'; kind: 'design-chat'; ids: [string] }
  | { version: 'v1'; provider: 'claude'; kind: 'project'; ids: [string] }
  | { version: 'v1'; provider: 'chatgpt'; kind: 'conversation'; ids: [string] }

const durableId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const id = value.trim()
  return id && isDurableScalar(id) ? id : null
}

export const serializeImportSourceLocator = (locator: ImportSourceLocator): string =>
  [locator.version, locator.provider, locator.kind, ...locator.ids.map(encodeUtf8Base64Url)].join(
    ':',
  )

const build = <T extends ImportSourceLocator>(
  locator: Omit<T, 'ids'>,
  values: readonly unknown[],
): string | null => {
  const ids = values.map(durableId)

  if (ids.some((id) => id == null)) {
    return null
  }

  return serializeImportSourceLocator({ ...locator, ids } as T)
}

export const claudeConversationSourceLocator = (uuid: unknown): string | null =>
  build<Extract<ImportSourceLocator, { provider: 'claude'; kind: 'conversation' }>>(
    { version: 'v1', provider: 'claude', kind: 'conversation' },
    [uuid],
  )

export const claudeProjectPromptSourceLocator = (projectUuid: unknown): string | null =>
  build<Extract<ImportSourceLocator, { kind: 'project-prompt' }>>(
    { version: 'v1', provider: 'claude', kind: 'project-prompt' },
    [projectUuid],
  )

export const claudeProjectDocSourceLocator = (
  projectUuid: unknown,
  docUuid: unknown,
): string | null =>
  build<Extract<ImportSourceLocator, { kind: 'project-doc' }>>(
    { version: 'v1', provider: 'claude', kind: 'project-doc' },
    [projectUuid, docUuid],
  )

export const claudeDesignChatSourceLocator = (uuid: unknown): string | null =>
  build<Extract<ImportSourceLocator, { kind: 'design-chat' }>>(
    { version: 'v1', provider: 'claude', kind: 'design-chat' },
    [uuid],
  )

export const claudeProjectPlacementLocator = (projectUuid: unknown): string | null =>
  build<Extract<ImportSourceLocator, { kind: 'project' }>>(
    { version: 'v1', provider: 'claude', kind: 'project' },
    [projectUuid],
  )

export const chatGptConversationSourceLocator = (id: unknown): string | null =>
  build<Extract<ImportSourceLocator, { provider: 'chatgpt' }>>(
    { version: 'v1', provider: 'chatgpt', kind: 'conversation' },
    [id],
  )

export const parseImportSourceLocator = (value: unknown): ImportSourceLocator | null => {
  if (typeof value !== 'string' || !isDurableScalar(value)) {
    return null
  }
  const [version, provider, kind, ...encodedIds] = value.split(':')
  const expectedArity =
    version !== 'v1'
      ? 0
      : provider === 'claude'
        ? kind === 'project-doc'
          ? 2
          : ['conversation', 'project-prompt', 'design-chat', 'project'].includes(kind)
            ? 1
            : 0
        : provider === 'chatgpt' && kind === 'conversation'
          ? 1
          : 0

  if (!expectedArity || encodedIds.length !== expectedArity) {
    return null
  }
  const ids = encodedIds.map(decodeUtf8Base64Url)

  if (ids.some((id) => id == null || durableId(id) !== id)) {
    return null
  }
  const locator = { version, provider, kind, ids } as ImportSourceLocator

  return serializeImportSourceLocator(locator) === value ? locator : null
}

export const isImportNoteSourceLocator = (value: unknown): value is string => {
  const parsed = parseImportSourceLocator(value)
  return parsed != null && parsed.kind !== 'project'
}
