import { resolve } from 'node:path'

import { preflightResourceRoots } from './roots'
import { SpaceResourceAuthority } from './spaceResourceAuthority'
import type { ResourceAuthorityAdapter, ResourceRootInput } from './types'

type RegisteredAuthority = {
  authority: SpaceResourceAuthority
  signature: string
  roots: ResourceRootInput[]
}

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
    const signature = signatureOf(adapters)
    const existing = this.entries.get(spaceId)

    if (existing) {
      if (existing.signature !== signature) {
        throw new Error(`resource authority composition changed for space ${spaceId}`)
      }

      return existing.authority
    }
    const roots = adapters.flatMap((adapter) =>
      adapter.physicalRoot ? [{ spaceId, adapterId: adapter.id, root: adapter.physicalRoot }] : [],
    )

    preflightResourceRoots([
      ...[...this.entries.values()].flatMap((entry) => entry.roots),
      ...roots,
    ])
    const authority = new SpaceResourceAuthority(spaceId, adapters)

    this.entries.set(spaceId, { authority, signature, roots })
    return authority
  }

  remove(spaceId: string): void {
    this.entries.delete(spaceId)
  }
}
