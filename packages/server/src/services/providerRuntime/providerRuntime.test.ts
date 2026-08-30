import { expect, it } from 'vitest'
import {
  PROVIDER_CALL_ERROR,
  PROVIDER_CALL_OUTCOME,
  PROVIDER_DELIVERY_STATE,
  WIRE,
} from '@notarium/contract'

import type { ProviderCallIntentInput } from '../metaDb'
import { ProviderRateLimitError, ProviderRuntime } from './index'
import { PROVIDER_CALL_KIND, PROVIDER_RETRY_MODE, type ProviderCallContext } from './types'

const CALL: ProviderCallContext = {
  owner: 'alice',
  principal: 'user:alice',
  agent: null,
  resourceId: 'resource-a',
  credentialId: null,
  spaces: [],
  job: null,
  rateLimit: { rpm: 1_000, tpm: null, inputUpperBound: 0, outputTokenBudget: 0 },
}

it('aborts an in-flight transport stage when the process runtime closes', async () => {
  let lookupStarted!: () => void
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve
  })
  const runtime = new ProviderRuntime({
    privateOrigins: new Set(['http://provider.test:11434']),
    // The intent precedes the send, so it is recorded; the abort then lands in DNS.
    callLog: {
      intent: async (input: ProviderCallIntentInput) => ({
        status: 'recorded' as const,
        record: {
          ...input,
          spaces: [...input.spaces],
          jobId: null,
          jobCallKey: null,
          attemptNo: null,
          deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
          retrySafe: false,
          outcome: PROVIDER_CALL_OUTCOME.inFlight,
          usage: null,
          settledAt: null,
        },
      }),
      settle: async () => null,
    },
    transport: {
      lookup: async () => {
        lookupStarted()
        return new Promise(() => {})
      },
    },
  })
  const call = runtime.execute({
    endpoint: {
      principalId: 'owner-1',
      wire: WIRE.ollama,
      baseUrl: 'http://provider.test:11434',
      headers: new Map(),
      sensitiveValues: new Set(),
      allowPrivateNetwork: true,
      firstByteTimeoutMs: null,
      callTimeoutMs: null,
    },
    operation: { kind: PROVIDER_CALL_KIND.models },
    retryMode: PROVIDER_RETRY_MODE.none,
    call: CALL,
    signal: new AbortController().signal,
  })

  await started
  runtime.close()
  await expect(call).rejects.toMatchObject({ code: PROVIDER_CALL_ERROR.canceled })
})

it('carries the retarget bucket through the owner barrel and one runtime instance', () => {
  const runtime = new ProviderRuntime({
    privateOrigins: new Set(),
    callLog: {
      intent: async () => {
        throw new Error('retarget admission does not write a call intent')
      },
      settle: async () => null,
    },
  })

  for (let index = 0; index < 5; index += 1) {
    runtime.admitRetarget('alice')
  }

  expect(() => runtime.admitRetarget('alice')).toThrow(ProviderRateLimitError)
  expect(() => runtime.admitRetarget('bob')).not.toThrow()
})
