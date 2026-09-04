import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer } from '../../packages/server/src/apps/server/server'

type Rpc = {
  result?: {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content?: Array<{ text?: string }>
  }
}

describe('production MCP ability create — real FS + SQLite', () => {
  let root: string
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notarium-mcp-ability-create-'))
    await mkdir(join(root, 'spaces'))
    app = await createServer({
      spaces: [],
      spacesRoot: join(root, 'spaces'),
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'password',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 0,
      replayKeyring: {
        path: join(root, 'replay-keys'),
        topology: 'canonical-local',
      },
    })
    await app.ready()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(root, { recursive: true, force: true })
  })

  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const response = await app!.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    })

    expect(response.statusCode).toBe(200)
    return response.json() as Rpc
  }

  const setupToken = async () => {
    const setup = await app!.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'alice', displayName: 'Alice', password: 'alice-password-1' },
    })
    expect(setup.statusCode).toBe(200)
    const cookie = String(setup.headers['set-cookie']).split(';')[0]
    const tokenResponse = await app!.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'Codex', scope: 'write' },
    })

    expect(tokenResponse.statusCode).toBe(201)
    return { cookie, setup, token: tokenResponse.json().token as string }
  }

  it('deletes a single-SKILL.md package into Trash and restores it through the human door', async () => {
    const { cookie, token } = await setupToken()
    const created = await call(token, 'create_ability', {
      kind: 'skill',
      name: 'required-delete-proof',
      description: 'Required tombstone proof.',
      instructions: '# Required delete proof\n\nRestore these exact instructions.',
      placement: { home: 'personal' },
      idempotencyKey: 'required-delete-proof-one',
    })

    expect(created.result?.isError).not.toBe(true)
    const ref = created.result!.structuredContent!.ref as string
    const removed = await call(token, 'delete_ability', { ref })

    expect(removed.result?.isError).not.toBe(true)
    const raw = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })
    let noteId: string

    try {
      noteId = (
        raw
          .prepare(`SELECT note_id FROM ability_create_operations WHERE phase = 'succeeded'`)
          .get() as { note_id: string }
      ).note_id
    } finally {
      raw.close()
    }
    const spaces = await app!.inject({ method: 'GET', url: '/api/spaces', headers: { cookie } })
    const [personal] = spaces.json().spaces as Array<{ id: string; slug: string }>
    const trash = await app!.inject({
      method: 'GET',
      url: `/api/s/${personal.slug}/trash`,
      headers: { cookie },
    })

    expect(trash.statusCode, trash.body).toBe(200)
    const tombstone = (
      trash.json().items as Array<{ noteId: string; revisionId: string; restorable: boolean }>
    ).find((item) => item.noteId === noteId)

    expect(tombstone).toMatchObject({ noteId, restorable: true })
    const restored = await app!.inject({
      method: 'POST',
      url: `/api/s/${personal.slug}/trash/restore`,
      headers: { cookie },
      payload: {
        id: noteId,
        revisionId: tombstone!.revisionId,
        idempotencyKey: 'restore-required-delete-proof-one',
      },
    })

    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json()).toMatchObject({ status: 'succeeded', id: noteId })
    const read = await call(token, 'get_ability', { ref })
    expect(read.result?.isError).not.toBe(true)
    expect(read.result?.structuredContent?.ability).toMatchObject({
      name: 'required-delete-proof',
      instructions: expect.stringContaining('Restore these exact instructions.'),
    })
  }, 15_000)

  it('creates directly on a cold store and survives a full server restart', async () => {
    const { token } = await setupToken()
    const created = await call(token, 'create_ability', {
      kind: 'skill',
      name: 'cold-direct-proof',
      description: 'No bootstrap may be required.',
      instructions: '# Cold direct proof\n\nPublish behind the causal fence.',
      placement: { home: 'personal' },
      idempotencyKey: 'cold-direct-proof-one',
    })
    const toolText = created.result?.content?.map(({ text }) => text ?? '').join('\n') ?? ''

    expect(created.result?.isError, toolText).not.toBe(true)
    const ref = created.result!.structuredContent!.ref as string
    const before = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      expect(
        before
          .prepare(
            `SELECT phase, i.materialized, i.deleted_at, i.address_revision,
                    (SELECT COUNT(*) FROM note_revisions r WHERE r.note_id = o.note_id) AS revisions,
                    (SELECT COUNT(*) FROM note_owner_proofs p WHERE p.note_id = o.note_id) AS proofs
               FROM ability_create_operations o
               JOIN note_identity i ON i.id = o.note_id
              WHERE o.id = (SELECT id FROM ability_create_operations LIMIT 1)`,
          )
          .get(),
      ).toEqual({
        phase: 'succeeded',
        materialized: 1,
        deleted_at: null,
        address_revision: 1,
        revisions: 1,
        proofs: 1,
      })
    } finally {
      before.close()
    }

    await app!.close()
    app = await createServer({
      spaces: [],
      spacesRoot: join(root, 'spaces'),
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'password',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 0,
      replayKeyring: {
        path: join(root, 'replay-keys'),
        topology: 'canonical-local',
      },
    })
    await app.ready()

    const read = await call(token, 'get_ability', { ref })
    expect(read.result?.isError).not.toBe(true)
    const after = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      expect(
        after
          .prepare(
            `SELECT COUNT(*) AS count FROM note_revisions
              WHERE note_id = (SELECT note_id FROM ability_create_operations LIMIT 1)`,
          )
          .get(),
      ).toEqual({ count: 1 })
    } finally {
      after.close()
    }
  })

  it('publishes one agent-attributed origin and exposes it in session Activity', async () => {
    const { cookie, setup, token } = await setupToken()
    // Attribution keys the owner by the stable id `me` reports, not by the handle.
    const aliceId = setup.json().id as string
    const started = await call(token, 'start_session', { session: { name: 'V8 proof' } })
    const session = started.result?.structuredContent?.session as { id: string }

    expect(session.id).toMatch(/^ses_/)
    const created = await call(token, 'create_ability', {
      session: session.id,
      kind: 'skill',
      name: 'durable-mcp-proof',
      description: 'Prove the real MCP publication path.',
      instructions: '# Durable MCP proof\n\nExact agent-authored body.',
      placement: { home: 'personal' },
      idempotencyKey: 'durable-mcp-proof-one',
    })
    const toolText = created.result?.content?.map(({ text }) => text ?? '').join('\n') ?? ''

    expect(created.result?.isError, toolText).not.toBe(true)
    expect(created.result?.structuredContent).toMatchObject({
      outcome: 'created',
      name: 'durable-mcp-proof',
      ref: expect.any(String),
    })
    const ref = created.result!.structuredContent!.ref as string
    const beforeRestartDb = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      const operation = beforeRestartDb
        .prepare(`SELECT note_id FROM ability_create_operations WHERE phase = 'succeeded'`)
        .get() as { note_id: string }
      expect(
        beforeRestartDb
          .prepare(`SELECT principal, entry_role FROM note_revisions WHERE note_id = ?`)
          .all(operation.note_id),
      ).toEqual([
        expect.objectContaining({
          principal: expect.stringMatching(new RegExp(`^pat:${aliceId}:`)),
          entry_role: 'origin',
        }),
      ])
    } finally {
      beforeRestartDb.close()
    }
    const [engineFile] = (await readdir(join(root, 'engine'))).filter((file) =>
      file.endsWith('.db'),
    )
    const beforeRestartIndex = new DatabaseSync(join(root, 'engine', engineFile), {
      readOnly: true,
    })

    try {
      expect(
        beforeRestartIndex.prepare(`SELECT COUNT(*) AS count FROM document_proofs`).get(),
      ).toEqual({ count: 1 })
    } finally {
      beforeRestartIndex.close()
    }

    await app!.close()
    const afterCloseDb = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      const operation = afterCloseDb
        .prepare(`SELECT note_id FROM ability_create_operations WHERE phase = 'succeeded'`)
        .get() as { note_id: string }
      expect(
        afterCloseDb
          .prepare(`SELECT id FROM note_revisions WHERE note_id = ?`)
          .all(operation.note_id),
      ).toHaveLength(1)
    } finally {
      afterCloseDb.close()
    }
    app = await createServer({
      spaces: [],
      spacesRoot: join(root, 'spaces'),
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'password',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 0,
      replayKeyring: {
        path: join(root, 'replay-keys'),
        topology: 'canonical-local',
      },
    })
    await app.ready()
    const afterRestartIndex = new DatabaseSync(join(root, 'engine', engineFile), { readOnly: true })

    try {
      expect(
        afterRestartIndex.prepare(`SELECT COUNT(*) AS count FROM document_proofs`).get(),
      ).toEqual({ count: 1 })
    } finally {
      afterRestartIndex.close()
    }
    const afterRestart = await call(token, 'get_ability', { ref })
    expect(afterRestart.result?.isError).not.toBe(true)
    const raw = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      const operation = raw
        .prepare(
          `SELECT package_id, note_id, target_path, phase
             FROM ability_create_operations WHERE phase = 'succeeded'`,
        )
        .get() as { package_id: string; note_id: string; target_path: string; phase: string }
      const revisions = raw
        .prepare(
          `SELECT principal, agent_owner, agent_name, session_id, session_name,
                  session_attach, entry_role
             FROM note_revisions WHERE note_id = ?`,
        )
        .all(operation.note_id) as Array<Record<string, unknown>>

      expect(revisions).toEqual([
        expect.objectContaining({
          principal: expect.stringMatching(new RegExp(`^pat:${aliceId}:`)),
          agent_owner: aliceId,
          agent_name: 'Codex',
          session_id: session.id,
          session_name: 'V8 proof',
          session_attach: 'declared',
          entry_role: 'origin',
        }),
      ])
      const personal = setup.json().personalSpace as string
      await expect(
        readFile(
          join(
            root,
            'spaces',
            personal,
            operation.target_path.replace('.notarium/skills/', '.notarium/skills/'),
          ),
          'utf8',
        ),
      ).resolves.toContain('Exact agent-authored body.')

      const activity = await app!.inject({
        method: 'GET',
        url: `/api/me/agent-sessions/${session.id}?filter=writes`,
        headers: { cookie },
      })
      expect(activity.statusCode).toBe(200)
      const createCall = activity
        .json()
        .events.find(
          (event: { type: string; tool?: string }) =>
            event.type === 'call' && event.tool === 'create_ability',
        ) as { id: string; principal: string } | undefined
      expect(createCall).toEqual(
        expect.objectContaining({
          principal: expect.stringMatching(new RegExp(`^pat:${aliceId}:`)),
        }),
      )

      const detail = await app!.inject({
        method: 'GET',
        url: `/api/me/agent-calls/${createCall!.id}`,
        headers: { cookie },
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json()).toMatchObject({
        links: { revisions: [expect.objectContaining({ noteId: operation.note_id })] },
      })
    } finally {
      raw.close()
    }
  })

  it('prepares declared field byte shape before the ability document save door', async () => {
    const { cookie, setup, token } = await setupToken()
    const created = await call(token, 'create_ability', {
      kind: 'skill',
      name: 'field-byte-shape',
      description: 'Ability field write proof.',
      instructions: '# Field byte shape\n\nBefore.',
      placement: { home: 'personal' },
      idempotencyKey: 'field-byte-shape-one',
    })
    expect(created.result?.isError).not.toBe(true)
    const operationDb = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })
    let operation: { note_id: string; target_path: string }

    try {
      operation = operationDb
        .prepare(
          `SELECT note_id, target_path FROM ability_create_operations WHERE phase = 'succeeded'`,
        )
        .get() as { note_id: string; target_path: string }
    } finally {
      operationDb.close()
    }
    const personal = setup.json().personalSpace as string
    const schema = await app!.inject({
      method: 'GET',
      url: `/api/s/${personal}/fields/schema`,
      headers: { cookie },
    })
    const schemaSaved = await app!.inject({
      method: 'PUT',
      url: `/api/s/${personal}/fields/schema`,
      headers: { cookie },
      payload: {
        version: 1,
        fields: [{ key: 'priority', type: 'number' }],
        versionToken: schema.json().versionToken,
      },
    })
    expect(schemaSaved.statusCode, schemaSaved.body).toBe(200)
    const before = await app!.inject({
      method: 'GET',
      url: `/api/note?id=${operation.note_id}`,
      headers: { cookie },
    })
    const saved = await app!.inject({
      method: 'POST',
      url: '/api/note',
      headers: { cookie },
      payload: {
        content: '# Field byte shape\n\nAfter.',
        originalId: operation.note_id,
        versionToken: before.json().versionToken,
        fields: { priority: '3' },
      },
    })

    expect(saved.statusCode, saved.body).toBe(200)
    await expect(
      readFile(join(root, 'spaces', setup.json().personalSpace, operation.target_path), 'utf8'),
    ).resolves.toMatch(/\npriority: 3\n/u)
  }, 15_000)
})
