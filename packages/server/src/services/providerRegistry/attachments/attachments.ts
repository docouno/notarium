import {
  ATTACHMENT_STATE,
  DEFAULT_CREDENTIAL_HEADER,
  PROVIDER_TARGET_KIND,
  type ProviderAttachmentAcceptRequest,
  type ProviderAttachmentListItem,
  type ProviderAttachmentView,
  type ProviderDisclosureSnapshot,
  type ProviderResource,
  type ProviderTargetKind,
} from '@notarium/contract'
import { freshNoteId } from '@notarium/core'

import type {
  CredentialRecord,
  CredentialsPersistence,
  ProjectRecord,
  ProjectsPersistence,
  ProviderAttachmentLifecyclePersistence,
  ProviderAttachmentRecord,
  ProviderAttachmentsPersistence,
  ProviderAttachmentTransitionState,
  ProviderPageInput,
  ProviderResourceRecord,
  ProviderResourcesPersistence,
  SpaceRecord,
  SpacesPersistence,
} from '../../metaDb'

const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const pendingProviderAttachment = (input: {
  resourceId: string
  targetKind: ProviderTargetKind
  targetId: string
  targetSpace: string
  now: Date
}): ProviderAttachmentRecord => ({
  id: freshNoteId(),
  resourceId: input.resourceId,
  targetKind: input.targetKind,
  targetId: input.targetId,
  targetSpace: input.targetSpace,
  state: ATTACHMENT_STATE.pending,
  resourceEpoch: null,
  credentialEpoch: null,
  disclosure: null,
  createdAt: input.now.toISOString(),
  expiresAt: new Date(input.now.getTime() + PENDING_TTL_MS).toISOString(),
})

export const providerDisclosureOf = (
  resource: ProviderResourceRecord,
  credential: CredentialRecord | null,
  targetSpace: string,
): ProviderDisclosureSnapshot => {
  const headerNames = new Set(Object.keys(resource.headers))

  if (credential) {
    headerNames.add(
      credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][resource.wire],
    )
  }

  return {
    targetSpace,
    resourceOwner: resource.owner,
    baseUrl: resource.baseUrl,
    purposes: [...resource.purposes],
    models: resource.models.map((model) => ({ ...model })),
    allowPrivateNetwork: resource.allowPrivateNetwork,
    headerNames: [...headerNames].sort(),
  }
}

const sameDisclosure = (
  before: ProviderDisclosureSnapshot | null,
  after: ProviderDisclosureSnapshot,
): boolean => before !== null && JSON.stringify(before) === JSON.stringify(after)

type ProviderAttachmentProjector = (
  record: ProviderResourceRecord,
  viewerOwner: string,
) => ProviderResource

type ProviderAttachmentListProjector = (
  record: ProviderResourceRecord,
  viewerOwner: string,
) => ProviderAttachmentListItem['resource']

export type ProviderAttachmentsServiceOptions = {
  attachments: ProviderAttachmentsPersistence
  lifecycle: ProviderAttachmentLifecyclePersistence
  resources: Pick<ProviderResourcesPersistence, 'get' | 'getMany'>
  credentials: Pick<CredentialsPersistence, 'get' | 'getMany'>
  spaces: Pick<SpacesPersistence, 'getById'>
  projects: Pick<ProjectsPersistence, 'getById'>
  projectResource: ProviderAttachmentProjector
  projectResourceListItem: ProviderAttachmentListProjector
  now?: () => Date
}

export class ProviderAttachmentsService {
  private readonly attachments: ProviderAttachmentsPersistence
  private readonly lifecycle: ProviderAttachmentLifecyclePersistence
  private readonly resources: Pick<ProviderResourcesPersistence, 'get' | 'getMany'>
  private readonly credentials: Pick<CredentialsPersistence, 'get' | 'getMany'>
  private readonly spaces: Pick<SpacesPersistence, 'getById'>
  private readonly projects: Pick<ProjectsPersistence, 'getById'>
  private readonly projectResource: ProviderAttachmentProjector
  private readonly projectResourceListItem: ProviderAttachmentListProjector
  private readonly now: () => Date

  constructor(options: ProviderAttachmentsServiceOptions) {
    this.attachments = options.attachments
    this.lifecycle = options.lifecycle
    this.resources = options.resources
    this.credentials = options.credentials
    this.spaces = options.spaces
    this.projects = options.projects
    this.projectResource = options.projectResource
    this.projectResourceListItem = options.projectResourceListItem
    this.now = options.now ?? (() => new Date())
  }

  get(id: string): Promise<ProviderAttachmentRecord | null> {
    return this.attachments.get(id)
  }

  targetSpace(targetKind: ProviderTargetKind, targetId: string): Promise<string | null> {
    return this.targetSpaceOf(targetKind, targetId)
  }

  async offer(input: {
    owner: string
    resourceId: string
    targetKind: ProviderTargetKind
    targetId: string
  }): Promise<
    | { status: 'offered'; view: ProviderAttachmentView }
    | { status: 'already-attached'; view: ProviderAttachmentView }
    | { status: 'not-found' }
  > {
    const resource = await this.resources.get(input.resourceId)

    if (!resource || resource.owner !== input.owner) {
      return { status: 'not-found' }
    }
    const targetSpace = await this.targetSpaceOf(input.targetKind, input.targetId)

    if (!targetSpace) {
      return { status: 'not-found' }
    }
    const result = await this.lifecycle.offerProviderAttachment(
      pendingProviderAttachment({ ...input, targetSpace, now: this.now() }),
      providerDisclosureOf,
    )

    if (
      result.status === 'missing-resource' ||
      result.status === 'target-gone' ||
      result.status === 'owner-not-member'
    ) {
      return { status: 'not-found' }
    }

    return {
      status: result.status,
      view: this.viewOf(result, input.owner),
    }
  }

  async pageForSpace(
    targetSpace: string,
    viewerOwner: string,
    input: ProviderPageInput,
  ): Promise<{ items: ProviderAttachmentListItem[]; total: number }> {
    const page = await this.attachments.pageIdsForSpace(
      targetSpace,
      this.now().toISOString(),
      input,
    )
    const loaded = await this.attachments.getMany(page.ids)
    const byId = new Map(loaded.map((record) => [record.id, record]))
    const records = page.ids.flatMap((id) => {
      const record = byId.get(id)
      return record ? [record] : []
    })
    const resourceIds = [...new Set(records.map(({ resourceId }) => resourceId))]
    const resources = this.resources.getMany
      ? await this.resources.getMany(resourceIds)
      : (await Promise.all(resourceIds.map((id) => this.resources.get(id)))).filter(
          (record): record is ProviderResourceRecord => record !== null,
        )
    const resourcesById = new Map(resources.map((record) => [record.id, record]))
    const items = records.flatMap((record) => {
      const resource = resourcesById.get(record.resourceId)

      if (!resource) {
        return []
      }

      return [
        {
          attachment: {
            id: record.id,
            resourceId: record.resourceId,
            targetKind: record.targetKind,
            targetId: record.targetId,
            targetSpace: record.targetSpace,
            state: record.state,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
          },
          resource: this.projectResourceListItem(resource, viewerOwner),
        },
      ]
    })

    return { items, total: page.total }
  }

  async detail(id: string, viewerOwner: string): Promise<ProviderAttachmentView | null> {
    const record = await this.attachments.get(id)

    if (
      !record ||
      (record.state === ATTACHMENT_STATE.pending && record.expiresAt <= this.now().toISOString())
    ) {
      return null
    }
    const state = await this.stateOf(record)
    return state ? this.viewOf(state, viewerOwner) : null
  }

  async accept(
    id: string,
    expected: ProviderAttachmentAcceptRequest,
    viewerOwner: string,
    manager: string | null,
  ): Promise<
    | { status: 'accepted' | 'already-active'; view: ProviderAttachmentView }
    | { status: 'epoch-conflict' | 'expired'; view: ProviderAttachmentView }
    | { status: 'not-found' }
  > {
    const result = await this.lifecycle.acceptProviderAttachment(
      {
        id,
        expectedResourceEpoch: expected.resourceEpoch,
        expectedCredentialEpoch: expected.credentialEpoch,
        acceptedAt: this.now().toISOString(),
        manager,
      },
      providerDisclosureOf,
    )

    if (
      result.status === 'missing' ||
      result.status === 'target-gone' ||
      result.status === 'owner-not-member'
    ) {
      return { status: 'not-found' }
    }

    return { status: result.status, view: this.viewOf(result, viewerOwner) }
  }

  detach(id: string, manager: string | null) {
    return this.lifecycle.detachProviderAttachment({ id, manager })
  }

  private async stateOf(
    record: ProviderAttachmentRecord,
  ): Promise<ProviderAttachmentTransitionState | null> {
    const resource = await this.resources.get(record.resourceId)

    if (!resource) {
      return null
    }
    const credential = resource.credentialId
      ? await this.credentials.get(resource.credentialId)
      : null

    return { record, resource, credential }
  }

  private viewOf(
    state: ProviderAttachmentTransitionState,
    viewerOwner: string,
  ): ProviderAttachmentView {
    const currentDisclosure = providerDisclosureOf(
      state.resource,
      state.credential,
      state.record.targetSpace,
    )

    return {
      attachment: state.record,
      resource: this.projectResource(state.resource, viewerOwner),
      currentEpochs: {
        resourceEpoch: state.resource.consentEpoch,
        credentialEpoch: state.credential?.consentEpoch ?? null,
      },
      currentDisclosure,
      diff: {
        before: state.record.disclosure,
        after: currentDisclosure,
        changed: !sameDisclosure(state.record.disclosure, currentDisclosure),
      },
    }
  }

  private async targetSpaceOf(
    targetKind: ProviderTargetKind,
    targetId: string,
  ): Promise<string | null> {
    let space: SpaceRecord | null

    if (targetKind === PROVIDER_TARGET_KIND.space) {
      space = await this.spaces.getById(targetId)
    } else {
      const project: ProjectRecord | null = await this.projects.getById(targetId)

      if (!project || project.status !== 'active') {
        return null
      }
      space = await this.spaces.getById(project.space)
    }

    return space && !space.archivedAt ? space.id : null
  }
}
