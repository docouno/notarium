import type { AdmissionDiagnostic, AdmissionLease, AdmissionRequest } from './types'

type NormalizedRequest = Omit<AdmissionRequest, 'packagePath'> & { packagePath: string }

type Entry = {
  id: string
  request: NormalizedRequest
  state: 'waiting' | 'active' | 'cancelling' | 'settled'
  controller: AbortController
  deadlineAt: number | null
  resolve: (lease: AdmissionLease) => void
  reject: (reason: unknown) => void
  timer?: ReturnType<typeof setTimeout>
  detachSignal?: () => void
}

let nextLeaseId = 1

const admissionError = (message: string, code: 'CANCELLED' | 'DEADLINE'): Error =>
  Object.assign(new Error(message), { code })

const packageOf = (entry: NormalizedRequest): string => entry.packagePath

const overlapsPackage = (left: string, right: string): boolean =>
  !left || !right || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)

const conflicts = (left: NormalizedRequest, right: NormalizedRequest): boolean => {
  if (!overlapsPackage(packageOf(left), packageOf(right))) {
    return false
  }
  if (left.scope === 'package' || right.scope === 'package') {
    if (left.scope === 'package' && left.mode === 'exclusive') {
      return true
    }
    if (right.scope === 'package' && right.mode === 'exclusive') {
      return true
    }

    return false
  }

  return left.path === right.path && (left.mode === 'exclusive' || right.mode === 'exclusive')
}

const normalized = (request: AdmissionRequest): NormalizedRequest => ({
  ...request,
  packagePath: request.scope === 'package' ? request.path : (request.packagePath ?? request.path),
})

/** Fair hierarchical admission for one space. Package-exclusive work blocks
 * every current and future member of its package; package-shared work composes
 * with member resource leases while preventing a package-exclusive overtake. */
export class ResourceAdmission {
  private readonly active = new Map<string, Entry>()
  private readonly waiting: Entry[] = []

  admit(request: AdmissionRequest): Promise<AdmissionLease> {
    if (!request.owner.trim()) {
      return Promise.reject(new Error('admission owner is required'))
    }
    if (
      request.deadlineMs != null &&
      (!Number.isFinite(request.deadlineMs) || request.deadlineMs < 0)
    ) {
      return Promise.reject(new Error('admission deadlineMs must be a non-negative number'))
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const entry: Entry = {
        id: `lease-${nextLeaseId++}`,
        request: normalized(request),
        state: 'waiting',
        controller: new AbortController(),
        deadlineAt: request.deadlineMs == null ? null : Date.now() + request.deadlineMs,
        resolve,
        reject,
      }

      const cancelWaiting = (reason: unknown, code: 'CANCELLED' | 'DEADLINE'): void => {
        if (entry.state !== 'waiting') {
          return
        }
        entry.state = 'settled'
        this.removeWaiting(entry)
        this.cleanup(entry)
        reject(
          reason instanceof Error
            ? reason
            : admissionError(
                code === 'DEADLINE' ? 'admission deadline exceeded' : 'admission cancelled',
                code,
              ),
        )
        this.drain()
      }

      if (request.signal?.aborted) {
        cancelWaiting(request.signal.reason, 'CANCELLED')
        return
      }
      if (request.signal) {
        const onAbort = (): void => {
          if (entry.state === 'waiting') {
            cancelWaiting(request.signal?.reason, 'CANCELLED')
          } else if (entry.state === 'active') {
            entry.state = 'cancelling'
            entry.controller.abort(request.signal?.reason)
          }
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        entry.detachSignal = () => request.signal?.removeEventListener('abort', onAbort)
      }
      if (request.deadlineMs != null) {
        entry.timer = setTimeout(() => {
          if (entry.state === 'waiting') {
            cancelWaiting(undefined, 'DEADLINE')
          } else if (entry.state === 'active') {
            entry.state = 'cancelling'
            entry.controller.abort(admissionError('active lease deadline exceeded', 'DEADLINE'))
          }
        }, request.deadlineMs)
      }

      this.waiting.push(entry)
      this.drain()
    })
  }

  /** How many APPLICATION leases are live right now. The fence's own drain lease is
   *  not one: it overlaps every key, so while it is held nothing else can be admitted
   *  and counting it would let an unadmitted caller read the drain as its own
   *  admission. */
  activeLeases(): number {
    let count = 0

    for (const entry of this.active.values()) {
      if (entry.state !== 'settled' && !entry.request.lifecycle) {
        count++
      }
    }

    return count
  }

  diagnostics(): AdmissionDiagnostic[] {
    return [...this.active.values(), ...this.waiting]
      .filter((entry) => entry.state !== 'settled')
      .map((entry) => ({
        id: entry.id,
        state: entry.state as AdmissionDiagnostic['state'],
        scope: entry.request.scope,
        mode: entry.request.mode,
        owner: entry.request.owner,
        path: entry.request.path,
        packagePath: entry.request.packagePath,
        deadlineAt: entry.deadlineAt,
      }))
  }

  private drain(): void {
    for (const entry of [...this.waiting]) {
      if (entry.state !== 'waiting') {
        continue
      }
      const index = this.waiting.indexOf(entry)
      const earlierConflict = this.waiting
        .slice(0, index)
        .some((earlier) => earlier.state === 'waiting' && conflicts(entry.request, earlier.request))
      const activeConflict = [...this.active.values()].some(
        (active) => active.state !== 'settled' && conflicts(entry.request, active.request),
      )

      if (earlierConflict || activeConflict) {
        continue
      }
      this.removeWaiting(entry)
      entry.state = 'active'
      this.active.set(entry.id, entry)
      entry.resolve(this.leaseFor(entry))
    }
  }

  private leaseFor(entry: Entry): AdmissionLease {
    const settle = (): void => {
      if (entry.state === 'settled') {
        return
      }
      entry.state = 'settled'
      this.active.delete(entry.id)
      this.removeWaiting(entry)
      this.cleanup(entry)
      this.drain()
    }

    const cancel = (reason?: unknown): void => {
      if (entry.state === 'settled' || entry.state === 'cancelling') {
        return
      }
      if (entry.state === 'waiting') {
        entry.state = 'settled'
        this.removeWaiting(entry)
        this.cleanup(entry)
        entry.reject(reason ?? admissionError('admission cancelled', 'CANCELLED'))
        this.drain()
        return
      }
      entry.state = 'cancelling'
      entry.controller.abort(reason ?? admissionError('active lease cancelled', 'CANCELLED'))
    }

    return {
      id: entry.id,
      scope: entry.request.scope,
      mode: entry.request.mode,
      owner: entry.request.owner,
      path: entry.request.path,
      packagePath: entry.request.packagePath,
      deadlineAt: entry.deadlineAt,
      signal: entry.controller.signal,
      cancel,
      settle,
    }
  }

  private removeWaiting(entry: Entry): void {
    const index = this.waiting.indexOf(entry)

    if (index >= 0) {
      this.waiting.splice(index, 1)
    }
  }

  private cleanup(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.detachSignal?.()
  }
}
