import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { PROVIDER_CALL_OUTCOME, PROVIDER_DELIVERY_STATE } from '@notarium/contract'
import {
  CREDENTIAL_KEY_STATE,
  type CredentialKeyringService,
  ProviderRegistry,
  type ProviderRuntime,
  SqliteMetaDb,
} from '@notarium/server'
import type { Ctx } from '../packages/server/src/services/mcp/gateway'
import { handleWhoami } from '../packages/server/src/services/mcp/tools/projectsList/projectsList'

const SOURCE_KEY_ID = `ck_${'1'.repeat(24)}`
const ACTIVE_KEY_ID = `ck_${'2'.repeat(24)}`
const OLD = '2026-01-01T00:00:00.000Z'
const RECENT = '2026-08-30T00:00:00.000Z'
const CUTOFF = '2026-06-01T00:00:00.000Z'
const BATCH = 1_000

export type ProviderScaleReport = {
  records: number
  carriers: number
  startupProbeMs: number
  unreadablePlanMs: number
  unreadableImpacts: number
  whoamiResolutionMs: number
  whoamiHasModel: boolean
  whoamiPortCalls: number
  whoamiMaxHydrated: number
  whoamiHydratedRows: number
  whoamiAllUnusableMs: number
  whoamiAllUnusableHasModel: boolean
  whoamiAllUnusablePortCalls: number
  whoamiAllUnusableMaxHydrated: number
  whoamiAllUnusableHydratedRows: number
  effectiveResolutionMs: number
  effectiveLaterMs: number
  effectiveRows: number
  effectiveTotal: number
  effectiveLaterRows: number
  effectivePortCalls: number
  effectiveLaterPortCalls: number
  effectiveMaxHydrated: number
  consentProjectionMs: number
  consentLaterMs: number
  consentRows: number
  consentTotal: number
  consentLaterRows: number
  consentPortCalls: number
  consentLaterPortCalls: number
  consentMaxHydrated: number
  retargetMs: number
  retargetReferences: number
  retargetAdmissions: number
  rotationMs: number
  rotationBatches: number
  rotatedCarriers: number
  journalPruneMs: number
  journalPruneBatches: number
  journalPruned: number
  journalRemaining: number
  dbMiB: number
  heapUsedMiB: number
}

const elapsed = (started: number): number => Number((performance.now() - started).toFixed(1))

const providerWhoami = (registry: ProviderRegistry) =>
  handleWhoami(
    {
      principal: {
        id: 'user:viewer',
        username: 'viewer',
        admin: false,
        scope: 'manage',
        grants: new Map([['space-main', 'reader']]),
        spaces: null,
        system: false,
      },
      providerRegistry: registry,
      readableProjects: async () => [],
      readableSpaces: async () => ['space-main'],
      spaces: {
        store: async () => ({
          capabilities: { vector: false, trash: false, revisions: false },
        }),
      },
    } as unknown as Ctx,
    {},
  )

const seed = (path: string, records: number): void => {
  const db = new DatabaseSync(path)
  const ciphertext = (suffix: string) => `v1.${SOURCE_KEY_ID}.${suffix}`
  const insertCredential = db.prepare(
    `INSERT INTO credentials
      (id, owner, name, kind, secret, origin, injection, disabled_at, rpm, tpm,
       consent_epoch, runtime_epoch)
     VALUES (?, 'scale-owner', ?, 'bearer', ?, 'https://provider.example',
       '{"header":"","prefix":"Bearer "}', NULL, NULL, NULL, 0, 0)`,
  )
  const insertResource = db.prepare(
    `INSERT INTO provider_resources
      (id, owner, name, wire, base_url, headers, allow_private_network,
       models, default_model, credential_id, consent_epoch, runtime_epoch, disabled_at,
       last_check, first_byte_timeout_ms, call_timeout_ms)
     VALUES (?, 'scale-owner', ?, 'openai-compatible', 'https://provider.example/v1', ?,
       0, '[{"name":"scale-model","capabilities":["completion"],"dimensions":null,"statusByCapability":{"completion":"available"}}]', NULL, ?, 0, 0, NULL, '{}', NULL, NULL)`,
  )
  const insertAttachment = db.prepare(
    `INSERT INTO provider_attachments
      (id, resource_id, target_kind, target_id, target_space, state,
       resource_epoch, credential_epoch, disclosure_snapshot, created_at, expires_at)
     VALUES (?, ?, 'project', ?, 'space-main', 'active', 0, 0, ?, ?, ?)`,
  )
  const insertCall = db.prepare(
    `INSERT INTO provider_call_log
      (id, owner, principal, agent, resource_id, credential_id, host, spaces,
       job_id, job_call_key, attempt_no, delivery_state, retry_safe, outcome,
       token_usage, created_at, settled_at)
     VALUES (?, 'scale-owner', 'user:scale-owner', NULL, 'resource-0', 'credential-0',
       'provider.example', '["main"]', NULL, NULL, NULL, ?, 0, ?, NULL, ?, ?)`,
  )

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO spaces
        (id, slug, notes_dir, display_name, aliases, created_at, archived_at, archived_by)
       VALUES ('space-main', 'main', 'main', 'Main', '[]', ?, NULL, NULL)`,
    ).run(OLD)
    db.prepare(
      `INSERT INTO users
        (username, display_name, password_hash, admin, disabled_at, created_at, personal_space)
       VALUES ('scale-owner', 'Scale Owner', NULL, 0, NULL, ?, NULL),
              ('viewer', 'Viewer', NULL, 0, NULL, ?, NULL)`,
    ).run(OLD, OLD)
    db.prepare(
      `INSERT INTO space_members (space, username, role, created_at)
       VALUES ('space-main', 'scale-owner', 'writer', ?),
              ('space-main', 'viewer', 'reader', ?)`,
    ).run(OLD, OLD)
    db.prepare(
      `INSERT INTO secret_keyring
        (key_id, canary, state, generation, created_at, retired_at)
       VALUES (?, ?, ?, 1, ?, ?), (?, ?, ?, 2, ?, NULL)`,
    ).run(
      SOURCE_KEY_ID,
      ciphertext('source-canary'),
      CREDENTIAL_KEY_STATE.readable,
      OLD,
      OLD,
      ACTIVE_KEY_ID,
      `v1.${ACTIVE_KEY_ID}.active-canary`,
      CREDENTIAL_KEY_STATE.active,
      RECENT,
    )
    for (let index = 0; index < records; index += 1) {
      insertCredential.run(
        `credential-${index}`,
        `Credential ${index}`,
        ciphertext(`secret-${index}`),
      )
      insertResource.run(
        `resource-${index}`,
        `Resource ${index}`,
        JSON.stringify({ 'x-scale-key': ciphertext(`header-${index}`) }),
        'credential-0',
      )
      insertAttachment.run(
        `attachment-${index}`,
        `resource-${index}`,
        `project-${index}`,
        JSON.stringify({
          targetSpace: 'space-main',
          resourceOwner: 'scale-owner',
          baseUrl: 'https://provider.example/v1',
          models: [{ name: 'scale-model', capabilities: ['completion'] }],
          allowPrivateNetwork: false,
          headerNames: ['authorization', 'x-scale-key'],
        }),
        OLD,
        '2027-01-01T00:00:00.000Z',
      )
      insertCall.run(
        `call-${String(index).padStart(6, '0')}`,
        PROVIDER_DELIVERY_STATE.sent,
        PROVIDER_CALL_OUTCOME.ok,
        OLD,
        OLD,
      )
    }
    insertCall.run(
      'call-in-flight',
      PROVIDER_DELIVERY_STATE.mayHaveSent,
      PROVIDER_CALL_OUTCOME.inFlight,
      OLD,
      null,
    )
    insertCall.run(
      'call-recent',
      PROVIDER_DELIVERY_STATE.sent,
      PROVIDER_CALL_OUTCOME.ok,
      RECENT,
      RECENT,
    )
    db.prepare(
      `INSERT INTO jobs
        (id, space, kind, status, principal, progress_done, attempts, max_attempts,
         run_at, created_at, updated_at)
       VALUES ('job-live', 'main', 'provider-scale', 'pending', 'user:scale-owner',
         0, 0, 3, ?, ?, ?)`,
    ).run(OLD, OLD, OLD)
    db.prepare(
      `INSERT INTO provider_call_log
        (id, owner, principal, agent, resource_id, credential_id, host, spaces,
         job_id, job_call_key, attempt_no, delivery_state, retry_safe, outcome,
         token_usage, created_at, settled_at)
       VALUES ('call-live-job', 'scale-owner', 'user:scale-owner', NULL,
         'resource-0', 'credential-0', 'provider.example', '["main"]',
         'job-live', 'call-0', 1, ?, 1, ?, NULL, ?, ?)`,
    ).run(PROVIDER_DELIVERY_STATE.notSent, PROVIDER_CALL_OUTCOME.policyDenied, OLD, OLD)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

const countedPort = <T extends object>(
  target: T,
  methods: ReadonlySet<PropertyKey>,
  count: () => void,
  observe?: (method: PropertyKey, args: unknown[]) => void,
): T =>
  new Proxy(target, {
    get: (subject, property, receiver) => {
      const value = Reflect.get(subject, property, receiver) as unknown

      if (typeof value !== 'function' || !methods.has(property)) {
        return value
      }

      return (...args: unknown[]) => {
        count()
        observe?.(property, args)
        return Reflect.apply(value, subject, args)
      }
    },
  })

export const runProviderScaleBench = async (records = 10_000): Promise<ProviderScaleReport> => {
  if (!Number.isSafeInteger(records) || records < 10_000) {
    throw new Error('provider scale artifact requires at least 10,000 records')
  }
  const root = mkdtempSync(join(tmpdir(), 'notarium-provider-scale-'))
  const path = join(root, 'meta.sqlite')
  let db: SqliteMetaDb | null = new SqliteMetaDb(path)

  try {
    await db.secretKeyring.list()
    await db.close()
    db = null
    seed(path, records)
    db = new SqliteMetaDb(path)

    let started = performance.now()
    const hasCiphertext = await db.providerCiphertexts.hasCiphertext()
    const startupProbeMs = elapsed(started)

    if (!hasCiphertext) {
      throw new Error('10k provider startup probe lost the ciphertext witness')
    }

    started = performance.now()
    const unreadable = await db.providerCiphertexts.previewUnreadable(new Set())
    const unreadablePlanMs = elapsed(started)

    if (unreadable.affected.length !== records * 2) {
      throw new Error(`provider unreadable plan returned ${unreadable.affected.length} impacts`)
    }

    let portCalls = 0
    let retargetAdmissions = 0
    let resourceMaxHydrated = 0
    let resourceHydratedRows = 0
    let consentMaxHydrated = 0
    const resources = countedPort(
      db.providerResources,
      new Set([
        'get',
        'getMany',
        'listForOwner',
        'pageIdsForOwner',
        'pageEffectiveIds',
        'scanEffectivePage',
      ]),
      () => (portCalls += 1),
      (method, args) => {
        if (method === 'getMany') {
          const rows = (args[0] as unknown[]).length
          resourceMaxHydrated = Math.max(resourceMaxHydrated, rows)
          resourceHydratedRows += rows
        }
      },
    )
    const credentials = countedPort(
      db.credentials,
      new Set(['get', 'getMany', 'references']),
      () => (portCalls += 1),
    )
    const attachments = countedPort(
      db.providerAttachments,
      new Set([
        'getMany',
        'listForSpace',
        'listForSpaces',
        'listForResourcesInSpaces',
        'pageIdsForSpace',
      ]),
      () => (portCalls += 1),
      (method, args) => {
        if (method === 'getMany') {
          consentMaxHydrated = Math.max(consentMaxHydrated, (args[0] as unknown[]).length)
        }
      },
    )
    const spaces = countedPort(db.spaces, new Set(['getById', 'getMany']), () => (portCalls += 1))
    const directory = countedPort(
      db.auth,
      new Set(['getUser', 'getUsers', 'grantsFor', 'grantsForUsers']),
      () => (portCalls += 1),
    )
    const keyring = {
      readableKeyIds: async () => {
        portCalls += 1
        return new Set([SOURCE_KEY_ID])
      },
    } as unknown as CredentialKeyringService
    const runtime = {
      admitRetarget: () => undefined,
      admitEndpoint: async () => {
        retargetAdmissions += 1
        return 'public'
      },
    } as unknown as ProviderRuntime
    const registry = new ProviderRegistry({
      credentials,
      resources,
      attachments,
      attachmentLifecycle: db,
      spaces,
      projects: db.projects,
      directory,
      keyring,
      runtime,
      privateOrigins: new Set(),
    })

    portCalls = 0
    resourceMaxHydrated = 0
    resourceHydratedRows = 0
    started = performance.now()
    const whoami = await providerWhoami(registry)
    const whoamiResolutionMs = elapsed(started)
    const whoamiHasModel = whoami.structured.hasModel === true
    const whoamiPortCalls = portCalls
    const whoamiMaxHydrated = resourceMaxHydrated
    const whoamiHydratedRows = resourceHydratedRows

    if (!whoamiHasModel || whoamiMaxHydrated > 100 || whoamiHydratedRows !== 100) {
      throw new Error(
        `provider whoami returned ${String(whoami.structured.hasModel)} with ${whoamiHydratedRows}/${whoamiMaxHydrated} hydration`,
      )
    }

    portCalls = 0
    resourceMaxHydrated = 0
    resourceHydratedRows = 0
    started = performance.now()
    const effective = await registry.resolveForPrincipalPage({
      owner: 'viewer',
      spaces: ['space-main'],
      after: null,
      limit: 101,
    })
    const effectiveResolutionMs = elapsed(started)
    const effectivePortCalls = portCalls

    if (
      effective.entries.length !== 101 ||
      effective.total !== records ||
      effective.entries.some((entry) => entry.unusableBecause !== null)
    ) {
      throw new Error(
        `provider effective page returned ${effective.entries.length}/${effective.total} usable rows`,
      )
    }
    const effectiveAfter = effective.entries[99]!.record
    portCalls = 0
    started = performance.now()
    const effectiveLater = await registry.resolveForPrincipalPage({
      owner: 'viewer',
      spaces: ['space-main'],
      after: { sort: effectiveAfter.name, id: effectiveAfter.id },
      limit: 101,
    })
    const effectiveLaterMs = elapsed(started)
    const effectiveLaterPortCalls = portCalls
    const effectiveMaxHydrated = resourceMaxHydrated

    portCalls = 0
    started = performance.now()
    const consent = await registry.pageAttachmentsForSpace('space-main', 'viewer', null, 101)
    const consentProjectionMs = elapsed(started)
    const consentPortCalls = portCalls

    if (consent.items.length !== 101 || consent.total !== records) {
      throw new Error(
        `provider consent page returned ${consent.items.length}/${consent.total} rows`,
      )
    }
    const consentAfter = consent.items[99]!.attachment
    portCalls = 0
    started = performance.now()
    const consentLater = await registry.pageAttachmentsForSpace(
      'space-main',
      'viewer',
      { sort: consentAfter.createdAt, id: consentAfter.id },
      101,
    )
    const consentLaterMs = elapsed(started)
    const consentLaterPortCalls = portCalls

    if (
      effectiveLater.entries.length !== 101 ||
      effectiveLater.entries.some((entry) =>
        effective.entries.slice(0, 100).some((first) => first.record.id === entry.record.id),
      ) ||
      consentLater.items.length !== 101 ||
      consentLater.items.some((item) =>
        consent.items.slice(0, 100).some((first) => first.attachment.id === item.attachment.id),
      )
    ) {
      throw new Error('provider later page repeated the first population')
    }

    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE provider_resources SET disabled_at = ?').run(RECENT)
    raw.close()
    portCalls = 0
    resourceMaxHydrated = 0
    resourceHydratedRows = 0
    started = performance.now()
    const allUnusableWhoami = await providerWhoami(registry)
    const whoamiAllUnusableMs = elapsed(started)
    const whoamiAllUnusableHasModel = allUnusableWhoami.structured.hasModel === true
    const whoamiAllUnusablePortCalls = portCalls
    const whoamiAllUnusableMaxHydrated = resourceMaxHydrated
    const whoamiAllUnusableHydratedRows = resourceHydratedRows

    if (
      whoamiAllUnusableHasModel ||
      whoamiAllUnusableMaxHydrated > 100 ||
      whoamiAllUnusableHydratedRows !== records
    ) {
      throw new Error(
        `provider all-unusable whoami returned ${String(allUnusableWhoami.structured.hasModel)} with ${whoamiAllUnusableHydratedRows}/${whoamiAllUnusableMaxHydrated} hydration`,
      )
    }
    const restore = new DatabaseSync(path)
    restore.prepare('UPDATE provider_resources SET disabled_at = NULL').run()
    restore.close()

    started = performance.now()
    const retarget = await registry.retargetCredential(
      'scale-owner',
      'credential-0',
      {
        origin: 'https://provider.example',
        resources: Array.from({ length: records }, (_, index) => ({
          id: `resource-${index}`,
          baseUrl: 'https://provider.example/v1',
          detachCredential: false,
        })),
      },
      new AbortController().signal,
    )
    const retargetMs = elapsed(started)

    if (!retarget || retarget.resources.length !== records || retargetAdmissions !== 1) {
      throw new Error(
        `provider retarget returned ${retarget?.resources.length ?? 0} rows / ${retargetAdmissions} admissions`,
      )
    }

    started = performance.now()
    let rotationBatches = 0
    let rotatedCarriers = 0

    for (;;) {
      const batch = await db.providerCiphertexts.rewrapBatch({
        active: { keyId: ACTIVE_KEY_ID, generation: 2 },
        sourceKeyIds: new Set([SOURCE_KEY_ID]),
        limit: BATCH,
        rewrap: async (carrier) =>
          carrier.ciphertext.replace(`v1.${SOURCE_KEY_ID}.`, `v1.${ACTIVE_KEY_ID}.`),
      })
      const changed = batch.rewrapped.credentials + batch.rewrapped.headers

      if (changed === 0) {
        break
      }
      rotationBatches += 1
      rotatedCarriers += changed
    }
    const rotationMs = elapsed(started)
    const references = await db.providerCiphertexts.countReferences(new Set([SOURCE_KEY_ID]))

    if (rotatedCarriers !== records * 2 || references.credentials || references.headers) {
      throw new Error(
        `provider rotation stopped at ${rotatedCarriers} carriers / ${JSON.stringify(references)}`,
      )
    }

    started = performance.now()
    let journalPruned = 0
    let journalPruneBatches = 0

    for (;;) {
      const removed = await db.providerCallLog.pruneTerminalBefore(CUTOFF, BATCH)

      if (removed === 0) {
        break
      }
      journalPruned += removed
      journalPruneBatches += 1
    }
    const journalPruneMs = elapsed(started)
    const journalRemaining = (await db.providerCallLog.listForOwner('scale-owner')).length

    if (journalPruned !== records || journalRemaining !== 3) {
      throw new Error(
        `provider journal retention pruned ${journalPruned}, left ${journalRemaining}`,
      )
    }

    await db.close()
    db = null
    const report: ProviderScaleReport = {
      records,
      carriers: records * 2,
      startupProbeMs,
      unreadablePlanMs,
      unreadableImpacts: unreadable.affected.length,
      whoamiResolutionMs,
      whoamiHasModel,
      whoamiPortCalls,
      whoamiMaxHydrated,
      whoamiHydratedRows,
      whoamiAllUnusableMs,
      whoamiAllUnusableHasModel,
      whoamiAllUnusablePortCalls,
      whoamiAllUnusableMaxHydrated,
      whoamiAllUnusableHydratedRows,
      effectiveResolutionMs,
      effectiveLaterMs,
      effectiveRows: effective.entries.length,
      effectiveTotal: effective.total,
      effectiveLaterRows: effectiveLater.entries.length,
      effectivePortCalls,
      effectiveLaterPortCalls,
      effectiveMaxHydrated,
      consentProjectionMs,
      consentLaterMs,
      consentRows: consent.items.length,
      consentTotal: consent.total,
      consentLaterRows: consentLater.items.length,
      consentPortCalls,
      consentLaterPortCalls,
      consentMaxHydrated,
      retargetMs,
      retargetReferences: retarget.resources.length,
      retargetAdmissions,
      rotationMs,
      rotationBatches,
      rotatedCarriers,
      journalPruneMs,
      journalPruneBatches,
      journalPruned,
      journalRemaining,
      dbMiB: Number((statSync(path).size / 1024 / 1024).toFixed(1)),
      heapUsedMiB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
    }

    return report
  } finally {
    await db?.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProviderScaleBench(Number(process.env.PROVIDER_SCALE_RECORDS ?? 10_000))
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
