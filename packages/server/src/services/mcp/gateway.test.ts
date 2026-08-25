import { describe, expect, it, vi } from 'vitest'
import { HTTP_STATUS } from '@notarium/contract/http'
import { memoryConvergenceExhausted } from '@notarium/core'

import { clientFailureOf } from '../../libs/clientFailure'
import {
  AbilityDiscoveryCursorError,
  AbilityPackageNotRestorableError,
  SystemAbilityNameConflictError,
} from '../abilities'
import { NoSuchAgentSessionError } from '../agentSessions'
import { AuthError, type AuthService } from '../auth'
import { SYSTEM_PRINCIPAL } from '../authz'
import { abilityTargetPurgedError } from '../metaDb'
import {
  AbilityUnavailableError,
  CatalogRoleNotFoundError,
  CatalogSkillNotFoundError,
  InvalidSkillPackageError,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
  RoleInstallUnavailableError,
  SkillAlreadyExistsError,
  SkillTooLargeForActivationError,
} from '../roles'
import type { SpaceManager } from '../spaces'
import { createGateway, toolErrorMessage } from './gateway'

describe('toolErrorMessage', () => {
  it('tells a memory convergence loser to repeat without asking for a caller token', () => {
    const error = memoryConvergenceExhausted('general', 9, {
      id: 'memory-id',
      title: 'general',
      class: 'agent-memory',
      filePath: '.notarium/memory/general.md',
      content: 'live body',
      frontmatter: {},
      versionToken: 'live-token',
    })
    const message = toolErrorMessage(error, 'remember_about_user')

    expect(message).toContain('Repeat the same call')
    expect(message).not.toContain('get_note')
    expect(message).not.toContain('versionToken')
  })

  describe('explicit client-failure contract', () => {
    it.each([
      new AbilityUnavailableError('writer grant missing'),
      abilityTargetPurgedError('ability target private-space/private-note was purged'),
      new AuthError(HTTP_STATUS.NOT_FOUND, 'private not-found detail'),
      new CatalogRoleNotFoundError('no such catalog role: private-name'),
      new CatalogSkillNotFoundError('no such catalog skill: private-name'),
    ])('projects %s as a message-free anti-enumeration not-found', (error) => {
      expect(clientFailureOf(error)).toEqual({ kind: 'not-found' })
      expect(toolErrorMessage(error, 'create_ability')).toBe('not found')
    })

    it.each([
      [
        new RoleAlreadyExistsError('role "review" already exists in personal'),
        'role "review" already exists in personal',
      ],
      [
        new SkillAlreadyExistsError('skill "review" already exists in personal'),
        'skill "review" already exists in personal',
      ],
      [
        new SystemAbilityNameConflictError('skill "review" conflicts with a System ability'),
        'skill "review" conflicts with a System ability',
      ],
    ])('projects %s as an explicitly authored conflict', (error, message) => {
      expect(clientFailureOf(error)).toEqual({ kind: 'conflict', message })
      expect(toolErrorMessage(error, 'create_ability')).toBe(message)
    })

    it('projects dependency details without leaking their raw project id', () => {
      const error = new RoleDependencyConflictError(
        'skill attachment "summarize" is unavailable for project private-project-id; widen its reach',
        {
          attachment: 'summarize',
          verdict: 'unavailable',
          rule: 'widen its reach',
          projectId: 'private-project-id',
        },
      )

      expect(clientFailureOf(error)).toEqual({
        kind: 'conflict',
        message: 'skill attachment "summarize" is unavailable; widen its reach',
      })
      expect(toolErrorMessage(error, 'create_ability')).not.toContain('private-project-id')
    })

    it('does not trust a dependency error message that has no structured details', () => {
      const error = new RoleDependencyConflictError(
        'attachment could not be read at /private/space/SKILL.md',
      )

      expect(clientFailureOf(error)).toEqual({
        kind: 'conflict',
        message: 'ability attachments conflict with the requested operation',
      })
      expect(toolErrorMessage(error, 'create_ability')).not.toContain('/private/space')
    })

    it.each([
      [
        new AuthError(HTTP_STATUS.BAD_REQUEST, 'versionToken is required for authored fields'),
        'versionToken is required for authored fields',
      ],
      [
        new RoleInstallUnavailableError('role installation is unavailable for this location'),
        'role installation is unavailable for this location',
      ],
      [
        new AbilityPackageNotRestorableError(
          'ability package contains auxiliary member "asset.bin"; remove it in the Agents UI',
        ),
        'ability package contains auxiliary member "asset.bin"; remove it in the Agents UI',
      ],
      [
        new SkillTooLargeForActivationError(101, 100),
        'SkillTooLargeForActivation { requiredTokens: 101, maxTokens: 100 } — read the ability with get_ability, then reduce or split it and retry with edit_ability',
      ],
      [new NoSuchAgentSessionError(), 'no such session — call start_session to open or resume one'],
    ])('projects %s as an explicitly authored actionable refusal', (error, message) => {
      expect(clientFailureOf(error)).toEqual({ kind: 'actionable', message })
      expect(toolErrorMessage(error, 'create_ability')).toBe(message)
    })

    it.each([
      new AuthError(HTTP_STATUS.CONFLICT, 'auth conflict stays transport-specific'),
      new InvalidSkillPackageError('raw invalid manifest details'),
      Object.assign(new Error('database password leaked'), { code: 'SQLITE_BUSY' }),
      Object.assign(new Error('private filesystem path'), { code: 'EACCES' }),
    ])('keeps unclassified %s opaque', (error) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

      expect(clientFailureOf(error)).toBeNull()
      expect(toolErrorMessage(error, 'create_ability')).toMatch(
        /^internal error \(ref: [0-9a-f]{6}\)$/,
      )
      expect(errorLog).toHaveBeenCalledOnce()
      errorLog.mockRestore()
    })

    it('leaves discovery cursor refusal to its handler-specific projection', () => {
      expect(clientFailureOf(new AbilityDiscoveryCursorError('bad cursor'))).toBeNull()
    })
  })

  it('preserves legacy other-tool error markers', () => {
    expect(
      toolErrorMessage(
        Object.assign(new Error('legacy conflict detail'), { isConflict: true }),
        'edit_note',
      ),
    ).toContain('Re-read it with get_note')
    expect(
      toolErrorMessage(
        Object.assign(new Error('legacy actionable detail'), { isToolError: true }),
        'move_note',
      ),
    ).toBe('legacy actionable detail')
  })

  it.each([{ isConflict: true }, { isNotFound: true }, { isToolError: true }])(
    'does not accept legacy %o markers from an ability error',
    (marker) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const error = Object.assign(new Error('postgres://agent:secret@db.internal/notarium'), marker)

      expect(toolErrorMessage(error, 'edit_ability')).toMatch(
        /^internal error \(ref: [0-9a-f]{6}\)$/,
      )
      expect(errorLog).toHaveBeenCalledOnce()
      errorLog.mockRestore()
    },
  )

  it('keeps an unexpected error opaque', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(toolErrorMessage(new Error('database password leaked'), 'edit_ability')).toMatch(
      /^internal error \(ref: [0-9a-f]{6}\)$/,
    )
    expect(errorLog).toHaveBeenCalledOnce()
    errorLog.mockRestore()
  })

  // The ref is the whole point: the SAME six hex chars must sit in the client answer
  // and in the server log line beside the real message, or the owner has an opaque
  // error with no way to find its cause.
  it('correlates an opaque failure with its server log line by ref', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const message = toolErrorMessage(new Error('database password leaked'), 'edit_ability')
    const ref = /^internal error \(ref: ([0-9a-f]{6})\)$/.exec(message)?.[1]

    expect(ref).toBeDefined()
    expect(errorLog).toHaveBeenCalledWith(
      `[mcp] edit_ability [${ref}] ->`,
      'database password leaked',
    )
    errorLog.mockRestore()
  })
})

describe('MCP gateway input boundary', () => {
  it('rejects an unknown argument before constructing a tool context', async () => {
    const list = vi.fn(() => {
      throw new Error('ctxFor must not read spaces for invalid input')
    })
    const gateway = createGateway({
      spaces: { list } as unknown as SpaceManager,
      auth: {} as AuthService,
    })

    const result = await gateway.callTool(SYSTEM_PRINCIPAL, 'whoami', { __unknown__: true })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringMatching(/invalid arguments/i) }),
    ])
    expect(list).not.toHaveBeenCalled()
  })
})
