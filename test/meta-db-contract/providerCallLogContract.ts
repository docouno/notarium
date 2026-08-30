import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CALL_ERROR,
  PROVIDER_CALL_OUTCOME,
  PROVIDER_DELIVERY_STATE,
  PROVIDER_TIMEOUT,
  PROVIDER_USAGE_SOURCE,
} from '@notarium/contract'

import {
  type JobsPersistence,
  type ProviderCallIntentInput,
  type ProviderCallLogPersistence,
  providerCallOutcomeAsRead,
  providerCallUsageTotals,
} from '../../packages/server/src/services/metaDb'

const AT = '2026-08-24T00:00:00.000Z'

const intent = (over: Partial<ProviderCallIntentInput> = {}): ProviderCallIntentInput => ({
  id: 'call-a',
  owner: 'alice',
  principal: 'user:alice',
  agent: null,
  resourceId: 'resource-a',
  credentialId: 'credential-a',
  host: 'provider.example',
  spaces: [],
  job: null,
  createdAt: AT,
  ...over,
})

export type ProviderCallLogContractFactory = () => Promise<{
  callLog: ProviderCallLogPersistence
  jobs?: JobsPersistence
  /** Present where the backend owns a Space purge; the journal must survive it. */
  purgeSpace?: (space: string) => Promise<void>
  teardown?: () => Promise<void>
}>

export const describeProviderCallLogContract = (
  name: string,
  factory: ProviderCallLogContractFactory,
): void => {
  describe(`Provider call log contract — ${name}`, { timeout: 15_000 }, () => {
    it('opens an interactive row in flight and closes it with the outcome', async () => {
      const subject = await factory()

      try {
        const opened = await subject.callLog.intent(intent())
        expect(opened).toMatchObject({
          status: 'recorded',
          record: {
            id: 'call-a',
            deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
            outcome: PROVIDER_CALL_OUTCOME.inFlight,
            retrySafe: false,
            usage: null,
            settledAt: null,
            jobId: null,
            jobCallKey: null,
            attemptNo: null,
          },
        })

        const settled = await subject.callLog.settle({
          id: 'call-a',
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          retrySafe: false,
          outcome: PROVIDER_CALL_OUTCOME.ok,
          usage: {
            source: PROVIDER_USAGE_SOURCE.openaiCompatible,
            promptTokens: 12,
            completionTokens: 2,
            totalTokens: 14,
            reasoningTokens: null,
            cachedPromptTokens: null,
            cost: 0.001,
            isByok: null,
            costDetails: null,
          },
          settledAt: '2026-08-24T00:00:01.000Z',
        })
        expect(settled).toMatchObject({
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          outcome: PROVIDER_CALL_OUTCOME.ok,
          settledAt: '2026-08-24T00:00:01.000Z',
          usage: { source: PROVIDER_USAGE_SOURCE.openaiCompatible, totalTokens: 14, cost: 0.001 },
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('records a refusal as its own row rather than as silence', async () => {
      const subject = await factory()

      try {
        await subject.callLog.intent(intent({ id: 'call-ok' }))
        await subject.callLog.settle({
          id: 'call-ok',
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          retrySafe: false,
          outcome: PROVIDER_CALL_OUTCOME.ok,
          usage: null,
          settledAt: AT,
        })
        await subject.callLog.intent(intent({ id: 'call-rejected' }))
        await subject.callLog.settle({
          id: 'call-rejected',
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          retrySafe: false,
          outcome: PROVIDER_CALL_ERROR.credentialRejected,
          usage: null,
          settledAt: AT,
        })

        const rows = await subject.callLog.listForOwner('alice')
        expect(rows.map((row) => row.outcome)).toEqual([
          PROVIDER_CALL_OUTCOME.ok,
          PROVIDER_CALL_ERROR.credentialRejected,
        ])
        // The spend of a refused call is unknown, and unknown is not zero.
        expect(providerCallUsageTotals(rows)).toEqual({
          calls: 2,
          tokens: 0,
          unknownUsageCalls: 2,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('keeps the credential id as a historical snapshot the owner cannot revoke', async () => {
      const subject = await factory()

      try {
        await subject.callLog.intent(intent({ credentialId: 'credential-gone' }))
        // There is no foreign key, so nothing about the credential's fate reaches the
        // row: it is the same id after the credential is deleted as it was before.
        const [row] = await subject.callLog.listForOwner('alice')
        expect(row.credentialId).toBe('credential-gone')
      } finally {
        await subject.teardown?.()
      }
    })

    it('numbers durable attempts and refuses a resend the last one did not license', async () => {
      const subject = await factory()
      const job = { jobId: 'job-1', jobCallKey: 'embed-batch-0' }

      try {
        const first = await subject.callLog.intent(intent({ id: 'call-1', job }))
        expect(first).toMatchObject({ status: 'recorded', record: { attemptNo: 1 } })

        // An intent nothing ever closed: the process may have died after the commit
        // and before the socket write, so a resend is exactly what must not happen.
        await expect(subject.callLog.intent(intent({ id: 'call-2', job }))).resolves.toMatchObject({
          status: 'blocked',
          record: { id: 'call-1', outcome: PROVIDER_CALL_OUTCOME.inFlight },
        })

        await subject.callLog.settle({
          id: 'call-1',
          deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          retrySafe: true,
          outcome: PROVIDER_CALL_ERROR.policyDenied,
          usage: null,
          settledAt: AT,
        })
        const second = await subject.callLog.intent(intent({ id: 'call-2', job }))
        expect(second).toMatchObject({ status: 'recorded', record: { attemptNo: 2 } })

        await subject.callLog.settle({
          id: 'call-2',
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          retrySafe: false,
          outcome: PROVIDER_CALL_ERROR.fallback,
          usage: null,
          settledAt: AT,
        })
        // The provider answered. Whatever the class, the call is on the bill.
        await expect(subject.callLog.intent(intent({ id: 'call-3', job }))).resolves.toMatchObject({
          status: 'blocked',
          record: { id: 'call-2', outcome: PROVIDER_CALL_ERROR.fallback },
        })
        expect(await subject.callLog.latestForJobCall('job-1', 'embed-batch-0')).toMatchObject({
          id: 'call-2',
          attemptNo: 2,
        })
        expect((await subject.callLog.listForOwner('alice')).map((row) => row.id)).toEqual([
          'call-1',
          'call-2',
        ])
      } finally {
        await subject.teardown?.()
      }
    })

    it('leaves a settled row alone when a second outcome arrives for it', async () => {
      const subject = await factory()

      try {
        await subject.callLog.intent(intent())
        await subject.callLog.settle({
          id: 'call-a',
          deliveryState: PROVIDER_DELIVERY_STATE.sent,
          retrySafe: false,
          outcome: PROVIDER_CALL_OUTCOME.ok,
          usage: null,
          settledAt: AT,
        })
        await expect(
          subject.callLog.settle({
            id: 'call-a',
            deliveryState: PROVIDER_DELIVERY_STATE.notSent,
            retrySafe: true,
            outcome: PROVIDER_CALL_ERROR.canceled,
            usage: null,
            settledAt: '2026-08-24T00:00:09.000Z',
          }),
        ).resolves.toMatchObject({
          outcome: PROVIDER_CALL_OUTCOME.ok,
          retrySafe: false,
          settledAt: AT,
        })
        await expect(
          subject.callLog.settle({
            id: 'call-missing',
            deliveryState: PROVIDER_DELIVERY_STATE.notSent,
            retrySafe: false,
            outcome: PROVIDER_CALL_ERROR.canceled,
            usage: null,
            settledAt: AT,
          }),
        ).resolves.toBeNull()
      } finally {
        await subject.teardown?.()
      }
    })

    it('reads an intent nothing closed as unknown once no call could still run', async () => {
      const subject = await factory()

      try {
        const opened = await subject.callLog.intent(intent())

        if (opened.status !== 'recorded') {
          throw new Error('the first intent of a logical call is never blocked')
        }
        const started = Date.parse(AT)
        // Inside the ceiling the row is what it says it is: a call may still be running.
        expect(
          providerCallOutcomeAsRead(
            opened.record,
            new Date(started + PROVIDER_TIMEOUT.callMaximumMs),
          ),
        ).toBe(PROVIDER_CALL_OUTCOME.inFlight)
        expect(
          providerCallOutcomeAsRead(
            opened.record,
            new Date(started + PROVIDER_TIMEOUT.callMaximumMs + 1),
          ),
        ).toBe(PROVIDER_CALL_ERROR.outcomeUnknown)
        // …and the table itself never changed: there is no background rechecker.
        expect(await subject.callLog.get('call-a')).toMatchObject({
          outcome: PROVIDER_CALL_OUTCOME.inFlight,
          settledAt: null,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('prunes only old settled terminal rows and respects the batch cap', async () => {
      const subject = await factory()
      const old = '2026-01-01T00:00:00.000Z'
      const cutoff = '2026-06-01T00:00:00.000Z'

      try {
        const terminal = async (id: string, settledAt: string) => {
          await subject.callLog.intent(intent({ id, createdAt: settledAt }))
          await subject.callLog.settle({
            id,
            deliveryState: PROVIDER_DELIVERY_STATE.sent,
            retrySafe: false,
            outcome: PROVIDER_CALL_OUTCOME.ok,
            usage: null,
            settledAt,
          })
        }
        await terminal('call-old-a', old)
        await terminal('call-old-b', old)
        await terminal('call-recent', AT)
        await subject.callLog.intent(intent({ id: 'call-in-flight', createdAt: old }))

        await expect(subject.callLog.pruneTerminalBefore(cutoff, 1)).resolves.toBe(1)
        await expect(subject.callLog.get('call-old-a')).resolves.toBeNull()
        await expect(subject.callLog.get('call-old-b')).resolves.not.toBeNull()
        await expect(subject.callLog.pruneTerminalBefore(cutoff)).resolves.toBe(1)
        await expect(subject.callLog.get('call-old-b')).resolves.toBeNull()
        await expect(subject.callLog.get('call-recent')).resolves.not.toBeNull()
        await expect(subject.callLog.get('call-in-flight')).resolves.toMatchObject({
          outcome: PROVIDER_CALL_OUTCOME.inFlight,
          settledAt: null,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('keeps terminal send-fence evidence while its durable job is live', async () => {
      const subject = await factory()

      if (!subject.jobs) {
        await subject.teardown?.()
        return
      }
      const old = '2026-01-01T00:00:00.000Z'

      try {
        await subject.jobs.enqueue({
          id: 'job-terminal',
          space: 'main',
          kind: 'provider-test',
          principal: 'user:alice',
          createdAt: old,
        })
        expect((await subject.jobs.claimNext('worker', ['provider-test'], old))?.id).toBe(
          'job-terminal',
        )
        expect(
          await subject.jobs.succeed('job-terminal', 'worker', {
            now: old,
          }),
        ).toBe(true)
        await subject.jobs.enqueue({
          id: 'job-live',
          space: 'main',
          kind: 'provider-test',
          principal: 'user:alice',
          createdAt: old,
        })
        const record = async (id: string, jobId: string) => {
          await subject.callLog.intent(
            intent({ id, createdAt: old, job: { jobId, jobCallKey: 'call-0' } }),
          )
          await subject.callLog.settle({
            id,
            deliveryState: PROVIDER_DELIVERY_STATE.notSent,
            retrySafe: true,
            outcome: PROVIDER_CALL_ERROR.policyDenied,
            usage: null,
            settledAt: old,
          })
        }
        await record('call-terminal-job', 'job-terminal')
        await record('call-live-job', 'job-live')

        await expect(subject.callLog.pruneTerminalBefore('2026-06-01T00:00:00.000Z')).resolves.toBe(
          1,
        )
        await expect(subject.callLog.get('call-terminal-job')).resolves.toBeNull()
        await expect(subject.callLog.get('call-live-job')).resolves.not.toBeNull()
      } finally {
        await subject.teardown?.()
      }
    })

    it('carries the context Spaces and survives the purge of every one of them', async () => {
      const subject = await factory()

      try {
        await subject.callLog.intent(intent({ spaces: ['space-a', 'space-b'] }))
        expect((await subject.callLog.listForOwner('alice'))[0].spaces).toEqual([
          'space-a',
          'space-b',
        ])

        if (subject.purgeSpace) {
          await subject.purgeSpace('space-a')
          // "Did that Space's content leave through this resource" is asked AFTER the
          // Space is gone, so the journal is owner-keyed and outlives it.
          expect((await subject.callLog.listForOwner('alice'))[0].spaces).toEqual([
            'space-a',
            'space-b',
          ])
        }
      } finally {
        await subject.teardown?.()
      }
    })

    it('sums the spend from the events and stores no total of its own', async () => {
      const subject = await factory()

      try {
        const record = async (
          id: string,
          usage: Parameters<typeof providerCallUsageTotals>[0][number]['usage'],
        ) => {
          await subject.callLog.intent(intent({ id }))
          await subject.callLog.settle({
            id,
            deliveryState: PROVIDER_DELIVERY_STATE.sent,
            retrySafe: false,
            outcome: PROVIDER_CALL_OUTCOME.ok,
            usage,
            settledAt: AT,
          })
        }
        await record('call-openai', {
          source: PROVIDER_USAGE_SOURCE.openaiCompatible,
          promptTokens: 5,
          completionTokens: 2,
          totalTokens: 7,
          reasoningTokens: null,
          cachedPromptTokens: null,
          cost: null,
          isByok: null,
          costDetails: null,
        })
        await record('call-ollama', {
          source: PROVIDER_USAGE_SOURCE.ollamaNative,
          totalDurationNs: null,
          loadDurationNs: null,
          promptEvalCount: 3,
          promptEvalDurationNs: null,
          evalCount: 4,
          evalDurationNs: null,
        })
        // A usage object without a total is still a count: prompt + completion is
        // what the wire said, and dropping it would understate the bill.
        await record('call-partial', {
          source: PROVIDER_USAGE_SOURCE.openaiCompatible,
          promptTokens: 6,
          completionTokens: null,
          totalTokens: null,
          reasoningTokens: null,
          cachedPromptTokens: null,
          cost: null,
          isByok: null,
          costDetails: null,
        })
        // …and a usage object that counted nothing is unknown, not zero — on either
        // wire, because both can answer with the shape and none of the numbers.
        await record('call-empty-openai', {
          source: PROVIDER_USAGE_SOURCE.openaiCompatible,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          reasoningTokens: null,
          cachedPromptTokens: null,
          cost: null,
          isByok: null,
          costDetails: null,
        })
        await record('call-empty-ollama', {
          source: PROVIDER_USAGE_SOURCE.ollamaNative,
          totalDurationNs: 1_000,
          loadDurationNs: null,
          promptEvalCount: null,
          promptEvalDurationNs: null,
          evalCount: null,
          evalDurationNs: null,
        })
        await record('call-silent', null)

        expect(providerCallUsageTotals(await subject.callLog.listForOwner('alice'))).toEqual({
          calls: 6,
          tokens: 20,
          unknownUsageCalls: 3,
        })
      } finally {
        await subject.teardown?.()
      }
    })

    it('keeps prompt and response text out of the record entirely', async () => {
      const subject = await factory()

      try {
        await subject.callLog.intent(intent())
        const [row] = await subject.callLog.listForOwner('alice')
        // Not "redacted" — absent. A field that could hold a prompt is a second store
        // of user content with a second access boundary.
        expect(Object.keys(row).sort()).toEqual([
          'agent',
          'attemptNo',
          'createdAt',
          'credentialId',
          'deliveryState',
          'host',
          'id',
          'jobCallKey',
          'jobId',
          'outcome',
          'owner',
          'principal',
          'resourceId',
          'retrySafe',
          'settledAt',
          'spaces',
          'usage',
        ])
      } finally {
        await subject.teardown?.()
      }
    })

    it('scopes the read to its owner', async () => {
      const subject = await factory()

      try {
        await subject.callLog.intent(intent({ id: 'call-alice' }))
        await subject.callLog.intent(intent({ id: 'call-bob', owner: 'bob' }))
        expect((await subject.callLog.listForOwner('alice')).map((row) => row.id)).toEqual([
          'call-alice',
        ])
        expect(await subject.callLog.latestForJobCall('job-x', 'key-x')).toBeNull()
        expect(await subject.callLog.get('call-missing')).toBeNull()
      } finally {
        await subject.teardown?.()
      }
    })
  })
}
