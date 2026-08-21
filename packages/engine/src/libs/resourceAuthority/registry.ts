import { resolve } from 'node:path'

import {
  adaptersInSnapshot,
  type ResourceAuthorityAdapterSnapshot,
  snapshotResourceAuthorityAdapters,
  trustedAdapterSnapshotInput,
  type TrustedResourceAuthorityAdapterSnapshotInput,
} from './adapterSnapshot'
import { preflightResourceRoots } from './roots'
import { SpaceResourceAuthority } from './spaceResourceAuthority'
import type { ResourceAuthorityAdapter, ResourceRootInput } from './types'

type RegisteredAuthority = {
  authority: SpaceResourceAuthority
  adapters: ResourceAuthorityAdapterSnapshot
  ownerIdentity?: object
  signature: string
  roots: ResourceRootInput[]
}

export type ResourceAuthorityOwner = Readonly<{
  adaptersForAuthority: () => readonly ResourceAuthorityAdapter[]
}>

const signatureOf = (adapters: readonly ResourceAuthorityAdapter[]): string =>
  JSON.stringify(
    adapters.map((adapter) => ({
      id: adapter.id,
      prefix: adapter.prefix,
      physicalRoot: adapter.physicalRoot ? resolve(adapter.physicalRoot) : null,
    })),
  )

/** Process composition registry: exactly one authority owns a space's physical
 * roots even when its store is evicted and reopened. Registration also gives
 * cross-space overlap one global preflight surface. */
export class SpaceResourceAuthorityRegistry {
  private readonly entries = new Map<string, RegisteredAuthority>()

  get(spaceId: string): SpaceResourceAuthority | undefined {
    return this.entries.get(spaceId)?.authority
  }

  getOrCreate(
    spaceId: string,
    adapters: readonly ResourceAuthorityAdapter[],
  ): SpaceResourceAuthority {
    return this.resolve(spaceId, adapters)
  }

  getOrCreateOwned({
    spaceId,
    owner,
  }: {
    spaceId: string
    owner: ResourceAuthorityOwner
  }): SpaceResourceAuthority {
    if (
      !owner ||
      typeof owner !== 'object' ||
      !Object.isFrozen(owner) ||
      typeof owner.adaptersForAuthority !== 'function'
    ) {
      throw new Error('owned resource authority registration requires a frozen owner')
    }

    return this.resolve(spaceId, owner.adaptersForAuthority(), owner)
  }

  private resolve(
    spaceId: string,
    adapters: readonly ResourceAuthorityAdapter[],
    ownerIdentity?: object,
  ): SpaceResourceAuthority {
    const adapterSnapshot = snapshotResourceAuthorityAdapters(adapters)
    const detachedAdapters = adaptersInSnapshot(adapterSnapshot)
    const signature = signatureOf(detachedAdapters)
    const existing = this.entries.get(spaceId)

    if (existing) {
      if (existing.signature !== signature) {
        throw new Error(`resource authority composition changed for space ${spaceId}`)
      }
      if (existing.ownerIdentity !== ownerIdentity) {
        throw new Error(`resource authority owner identity changed for space ${spaceId}`)
      }

      return existing.authority
    }
    const roots = detachedAdapters.flatMap((adapter) =>
      adapter.physicalRoot ? [{ spaceId, adapterId: adapter.id, root: adapter.physicalRoot }] : [],
    )

    preflightResourceRoots([
      ...[...this.entries.values()].flatMap((entry) => entry.roots),
      ...roots,
    ])
    const AuthorityFromSnapshot = SpaceResourceAuthority as unknown as new (
      spaceId: string,
      input: TrustedResourceAuthorityAdapterSnapshotInput,
    ) => SpaceResourceAuthority
    const authority = new AuthorityFromSnapshot(
      spaceId,
      trustedAdapterSnapshotInput(adapterSnapshot),
    )

    this.entries.set(spaceId, {
      authority,
      adapters: adapterSnapshot,
      ownerIdentity,
      signature,
      roots,
    })
    return authority
  }

  remove(spaceId: string): void {
    this.entries.delete(spaceId)
  }
}
