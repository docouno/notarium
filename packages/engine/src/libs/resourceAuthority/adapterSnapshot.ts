import type { ResourceAuthorityAdapter } from './types'

const frozenBoundMethod = <Arguments extends unknown[], Result>(
  receiver: object,
  method: (...args: Arguments) => Result,
): ((...args: Arguments) => Result) => Object.freeze(method.bind(receiver))

const snapshotAdapter = (adapter: ResourceAuthorityAdapter): ResourceAuthorityAdapter => {
  const id = adapter.id
  const prefix = adapter.prefix
  const physicalRoot = adapter.physicalRoot
  const files = adapter.files
  const scan = files.scan
  const read = files.read
  const dirExists = files.dirExists
  const capabilities = adapter.capabilities
  const resourceExport = capabilities.resourceExport
  const resourceObservation = capabilities.resourceObservation
  const resourcePublication = capabilities.resourcePublication
  const claimedRemoval = capabilities.claimedRemoval
  const packagePublication = capabilities.packagePublication
  const strictPublication = capabilities.strictPublication

  return Object.freeze({
    id,
    prefix,
    ...(physicalRoot === undefined ? {} : { physicalRoot }),
    files: Object.freeze({
      scan: frozenBoundMethod(files, scan),
      read: frozenBoundMethod(files, read),
      dirExists: frozenBoundMethod(files, dirExists),
    }),
    capabilities: Object.freeze({
      ...(resourceExport
        ? {
            resourceExport: Object.freeze({
              exportFiles: frozenBoundMethod(resourceExport, resourceExport.exportFiles),
            }),
          }
        : {}),
      ...(resourceObservation
        ? {
            resourceObservation: Object.freeze({
              observe: frozenBoundMethod(resourceObservation, resourceObservation.observe),
            }),
          }
        : {}),
      ...(resourcePublication
        ? {
            resourcePublication: Object.freeze({
              publish: frozenBoundMethod(resourcePublication, resourcePublication.publish),
            }),
          }
        : {}),
      ...(claimedRemoval
        ? {
            claimedRemoval: Object.freeze({
              removeIfClaimed: frozenBoundMethod(claimedRemoval, claimedRemoval.removeIfClaimed),
            }),
          }
        : {}),
      ...(packagePublication
        ? {
            packagePublication: Object.freeze({
              publishPackageIfAbsent: frozenBoundMethod(
                packagePublication,
                packagePublication.publishPackageIfAbsent,
              ),
            }),
          }
        : {}),
      ...(strictPublication
        ? {
            strictPublication: Object.freeze({
              restartDurable: strictPublication.restartDurable,
              stage: frozenBoundMethod(strictPublication, strictPublication.stage),
              inspect: frozenBoundMethod(strictPublication, strictPublication.inspect),
              publish: frozenBoundMethod(strictPublication, strictPublication.publish),
              discard: frozenBoundMethod(strictPublication, strictPublication.discard),
            }),
          }
        : {}),
    }),
  })
}

const adapterSnapshots = new WeakMap<
  ResourceAuthorityAdapterSnapshot,
  readonly ResourceAuthorityAdapter[]
>()

/** Opaque proof that every adapter view and bound method has been detached.
 * It is intentionally internal to the resource-authority module and absent
 * from its barrel. The WeakMap is the runtime brand; a structural lookalike
 * cannot enter the trusted constructor path through a cast. */
export class ResourceAuthorityAdapterSnapshot {
  private readonly nominal!: void

  private constructor() {}

  static capture(adapters: readonly ResourceAuthorityAdapter[]): ResourceAuthorityAdapterSnapshot {
    const snapshot = new ResourceAuthorityAdapterSnapshot()
    const detached = Object.freeze(adapters.map(snapshotAdapter))

    adapterSnapshots.set(snapshot, detached)
    return Object.freeze(snapshot) as ResourceAuthorityAdapterSnapshot
  }
}

export const snapshotResourceAuthorityAdapters = (
  adapters: readonly ResourceAuthorityAdapter[],
): ResourceAuthorityAdapterSnapshot => ResourceAuthorityAdapterSnapshot.capture(adapters)

export const adaptersInSnapshot = (
  snapshot: ResourceAuthorityAdapterSnapshot,
): readonly ResourceAuthorityAdapter[] => {
  const adapters = adapterSnapshots.get(snapshot)

  if (!adapters) {
    throw new Error('resource authority adapter snapshot must be created by its factory')
  }

  return adapters
}

const trustedInputs = new WeakMap<
  TrustedResourceAuthorityAdapterSnapshotInput,
  ResourceAuthorityAdapterSnapshot
>()

/** Constructor input used only between the registry and the authority module.
 * Its public constructor overload never admits this type. */
export type TrustedResourceAuthorityAdapterSnapshotInput = Readonly<{
  trustedResourceAuthorityAdapterSnapshotInput: true
}>

export const trustedAdapterSnapshotInput = (
  snapshot: ResourceAuthorityAdapterSnapshot,
): TrustedResourceAuthorityAdapterSnapshotInput => {
  adaptersInSnapshot(snapshot)
  const input: TrustedResourceAuthorityAdapterSnapshotInput = Object.freeze({
    trustedResourceAuthorityAdapterSnapshotInput: true,
  })

  trustedInputs.set(input, snapshot)
  return input
}

export const snapshotInTrustedInput = (
  value: unknown,
): ResourceAuthorityAdapterSnapshot | undefined =>
  typeof value === 'object' && value !== null
    ? trustedInputs.get(value as TrustedResourceAuthorityAdapterSnapshotInput)
    : undefined
