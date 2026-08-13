import { Buffer } from 'node:buffer'

import {
  analyzeDocumentState,
  bindStorageOwnerProof,
  encodeDocumentState,
  type RevisionBlob,
  type RevisionRestoreAvailability,
  revisionRestoreAvailability,
} from '@notarium/core'

import type { RevisionStateDecl } from './types'

export type MaterializedRevisionState = {
  blob: RevisionBlob | null
  content: string | null
  semanticFingerprint: string | null
  stateFormat: 'markdown-v1' | 'markdown-v2' | 'skill-markdown-v1' | 'opaque-v1' | null
  restoreSafety: 'safe' | 'blocked' | 'unknown' | null
  restoreAvailability: RevisionRestoreAvailability
  title: string
}

const sourceBytes = (
  source: Extract<RevisionStateDecl['state'], { kind: 'document' }>['source'],
): Uint8Array =>
  source.encoding === 'utf8'
    ? new TextEncoder().encode(source.data)
    : Uint8Array.from(Buffer.from(source.data, 'base64'))

const replaceSeedTokens = (
  source: Uint8Array,
  context: { noteId: string; path: string; createdAt: string },
): Uint8Array => {
  let text: string

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source)
  } catch {
    return source
  }

  return new TextEncoder().encode(
    text
      .replaceAll('{{noteId}}', context.noteId)
      .replaceAll('{{path}}', context.path)
      .replaceAll('{{createdAt}}', context.createdAt),
  )
}

export const materializeRevisionState = (
  declaration: RevisionStateDecl,
  context: { noteId: string; path: string; createdAt: string; title: string },
): MaterializedRevisionState => {
  if (declaration.state.kind === 'gap') {
    return {
      blob: null,
      content: null,
      semanticFingerprint: null,
      stateFormat: null,
      restoreSafety: null,
      restoreAvailability: 'gap',
      title: declaration.title ?? context.title,
    }
  }
  if (declaration.state.kind === 'legacy') {
    return {
      blob: declaration.state.content,
      content: declaration.state.content,
      semanticFingerprint: null,
      stateFormat: null,
      restoreSafety: null,
      restoreAvailability: 'partial',
      title: declaration.title ?? context.title,
    }
  }
  const source = replaceSeedTokens(sourceBytes(declaration.state.source), context)
  const ownerProof = declaration.state.ownerClaims?.length
    ? bindStorageOwnerProof({
        source,
        owners: declaration.state.ownerClaims,
        evidence: { kind: 'mutation-receipt', id: `seed:${context.noteId}:${declaration.date}` },
        generatedContainer: declaration.state.generatedContainer,
      })
    : undefined
  const state = analyzeDocumentState({
    source,
    role: declaration.state.role,
    pathFallbackTitle: declaration.state.pathFallbackTitle,
    skillDirectoryName: declaration.state.skillDirectoryName,
    ownerProof,
  })
  const restoreAvailability = revisionRestoreAvailability({
    contentHash: 'seeded',
    stateFormat: state.format,
    restoreSafety: state.restoreSafety.status,
  })

  return {
    blob: encodeDocumentState(state),
    content: state.projection?.body ?? null,
    semanticFingerprint: state.semanticFingerprint,
    stateFormat: state.format,
    restoreSafety: state.restoreSafety.status,
    restoreAvailability,
    title: declaration.title ?? state.projection?.title ?? context.title,
  }
}
