import type { MutationGate } from '../../libs/mutationGate'
import {
  type ProviderCallJournal,
  ProviderExecutor,
  type ProviderExecutorDependencies,
} from './executor'
import {
  probeProvider,
  type ProviderValidateInput,
  type ProviderValidateOutcome,
} from './executor/validate'
import { ProviderRateLimiter, type ProviderRateLimiterOptions } from './rateLimiter'
import type { ProviderTransportDependencies } from './transport/types'
import type { ProviderCallRequest, ProviderCallResult } from './types'

export type ProviderRuntimeOptions = {
  privateOrigins: ReadonlySet<string>
  /** Mandatory: a call this host cannot record is a call it does not make. */
  callLog: ProviderCallJournal
  mutationGate?: Pick<MutationGate, 'run'>
  transport?: ProviderTransportDependencies
  executor?: ProviderExecutorDependencies
  rateLimiter?: ProviderRateLimiterOptions
}

export class ProviderRuntime {
  private readonly executor: ProviderExecutor
  private readonly limiter: ProviderRateLimiter
  private readonly shutdown = new AbortController()

  constructor(options: ProviderRuntimeOptions) {
    this.limiter = new ProviderRateLimiter(options.rateLimiter)
    this.executor = new ProviderExecutor(
      options.privateOrigins,
      options.callLog,
      this.limiter,
      options.mutationGate,
      options.executor,
      options.transport,
    )
  }

  execute(input: ProviderCallRequest): Promise<ProviderCallResult> {
    return this.executor.execute({
      ...input,
      signal: AbortSignal.any([input.signal, this.shutdown.signal]),
    })
  }

  /** The product caller of the executor. The host ceiling is charged here and not
   *  in the route, because the limiter is an internal of this module and reaching
   *  past the barrel would put a second copy of the rule outside its owner. */
  /** Charge the host ceiling for one `validate`. Admission is separate from the probe
   *  because it must bound the whole OPERATION, not just the socket: an outcome that
   *  is decided locally still writes a row, and an uncapped write loop moves
   *  `PRAGMA data_version` under every online-backup attempt.
   *
   *  `async` on purpose: the refusal must arrive as a rejected promise like every
   *  other failure of this call, not as a synchronous throw a `.catch()` misses. */
  async admitValidate(owner: string): Promise<void> {
    this.limiter.reserveHostValidate(owner)
  }

  admitRetarget(owner: string): void {
    this.limiter.reserveRetarget(owner)
  }

  admitEndpoint(input: { baseUrl: string; allowPrivateNetwork: boolean; signal: AbortSignal }) {
    return this.executor.admitEndpoint({
      ...input,
      signal: AbortSignal.any([input.signal, this.shutdown.signal]),
    })
  }

  /** Runs the probe for an already-admitted `validate`. */
  validate(input: ProviderValidateInput): Promise<ProviderValidateOutcome> {
    return probeProvider((request) => this.execute(request), {
      ...input,
      signal: AbortSignal.any([input.signal, this.shutdown.signal]),
    })
  }

  close(): void {
    this.shutdown.abort(new Error('provider runtime is shutting down'))
  }
}
