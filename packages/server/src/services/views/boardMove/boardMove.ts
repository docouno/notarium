import {
  type BoardMoveRequest,
  BoardMoveRequestSchema,
  type BoardMoveResponse,
  type ViewDefinitionV1,
  ViewDefinitionV1Schema,
  type ViewSourceV1,
  ViewSourceV1Schema,
} from '@notarium/contract'
import {
  type BoardOptions,
  decodeViewRef,
  jitteredBoardRank,
  type KnowledgeStore,
  parseBoardRanks,
  parseViewDocument,
  putViewRank,
  type RankBitSource,
  rankNeedsRebalance,
  type ReaderRegistry,
  rebalanceBoardRanks,
  replaceViewRanks,
  VIEW_BLOCK_STATUS,
} from '@notarium/core'

import type { FieldSchemaSnapshot, FieldSchemaStore } from '../../fields'
import type { ProjectRecord } from '../../metaDb'
import { ViewExecutionService } from '../execution'
import { VIEW_READER_REGISTRY, VIEW_SOURCE_REGISTRY } from '../registry'
import type { ViewSourceBoardMoveAdapter, ViewSourceRegistry } from '../sourceRegistry'
import { BoardMoveError } from './errors'

const CARD_WRITE_ATTEMPTS = 3
const RANK_WRITE_ATTEMPTS = 3

type ResolvedBoard = {
  note: Awaited<ReturnType<KnowledgeStore['read']>>
  parsed: ReturnType<typeof parseViewDocument>
  view: ReturnType<typeof parseViewDocument>['views'][number]
  source: ViewSourceV1
  definition: ViewDefinitionV1
  options: BoardOptions
  groupField: string
  mutation: ViewSourceBoardMoveAdapter
  prepared: Awaited<ReturnType<ViewExecutionService['prepare']>>
  signature: string
}

type PartialMove = Extract<BoardMoveResponse, { status: 'moved-partial' }>

type Placement = {
  previousId?: string
  nextId?: string
}

const semanticSignature = (source: unknown, definition: unknown): string => {
  const copy = JSON.parse(JSON.stringify({ source, definition })) as {
    source: unknown
    definition: { options?: { order?: { ranks?: unknown } } }
  }

  if (copy.definition.options?.order) {
    delete copy.definition.options.order.ranks
  }

  return JSON.stringify(copy)
}

export class BoardMoveService {
  private readonly views: ViewExecutionService

  constructor(
    private readonly bits: RankBitSource,
    readers: ReaderRegistry = VIEW_READER_REGISTRY,
    private readonly sources: ViewSourceRegistry = VIEW_SOURCE_REGISTRY,
  ) {
    this.views = new ViewExecutionService(readers, sources)
  }

  private async resolve(input: {
    store: KnowledgeStore
    viewRef: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    allowNewToken?: boolean
  }): Promise<ResolvedBoard> {
    const decoded = decodeViewRef(input.viewRef)

    if (!decoded) {
      throw new BoardMoveError('stale viewRef')
    }
    const note = await input.store.read(decoded.documentId)
    const versionToken = note.versionToken

    if (!versionToken) {
      throw new BoardMoveError('view document has no version token')
    }
    if (!input.allowNewToken && versionToken !== decoded.versionToken) {
      const error = new BoardMoveError('stale viewRef')
      error.status = 409
      throw error
    }
    const parsed = parseViewDocument(note.content, {
      documentId: decoded.documentId,
      versionToken,
    })
    const view = input.allowNewToken
      ? parsed.views.find(
          (candidate) => candidate.block === decoded.block && candidate.occurrence === decoded.view,
        )
      : parsed.views.find((candidate) => candidate.viewRef === input.viewRef)

    const block = view ? parsed.blocks[view.block] : undefined

    if (
      !view ||
      !view.viewRef ||
      !note.filePath ||
      !block ||
      block.status !== VIEW_BLOCK_STATUS.ready ||
      !block.complete
    ) {
      throw new BoardMoveError('view was deleted')
    }
    const source = ViewSourceV1Schema.safeParse(block?.source)
    const definition = ViewDefinitionV1Schema.safeParse(view.definition)

    if (!source.success || !definition.success || definition.data.type !== 'board') {
      throw new BoardMoveError('view is not an executable board')
    }
    const slash = note.filePath.lastIndexOf('/')
    const prepared = await this.views.prepare({
      store: input.store,
      source: source.data,
      view: definition.data,
      directory: slash < 0 ? '' : note.filePath.slice(0, slash),
      projects: input.projects,
      schema: input.schema,
    })

    if (prepared.status !== 'ready') {
      throw new BoardMoveError(
        prepared.status === 'incomplete'
          ? 'board membership is incomplete'
          : (prepared.diagnostics?.[0] ?? 'board source is unavailable'),
      )
    }
    if (prepared.groupsTruncated) {
      throw new BoardMoveError('board grouping is truncated')
    }
    if (!prepared.capabilities?.move) {
      throw new BoardMoveError('board source is read-only')
    }
    const options = prepared.readerOptions as BoardOptions | undefined
    const mutation = this.sources.get(source.data.kind)?.boardMove
    const groupField = mutation?.fieldKey(prepared.readerOptions)

    if (!mutation || !groupField || !options?.groupBy || options.order?.kind !== 'manual') {
      throw new BoardMoveError('board options are invalid')
    }

    return {
      note,
      parsed,
      view,
      source: source.data,
      definition: definition.data,
      options,
      groupField,
      mutation,
      prepared,
      signature: semanticSignature(source.data, definition.data),
    }
  }

  private rowsInGroup(
    board: ResolvedBoard,
    group: string,
  ): ReturnType<ViewExecutionService['window']> {
    return this.views.window(board.prepared, {
      group,
      offset: 0,
      limit: board.prepared.total ?? 0,
    })
  }

  private targetGroup(board: ResolvedBoard, to: BoardMoveRequest['to']): string {
    const group = board.prepared.groups?.find((candidate) =>
      to.kind === 'absent'
        ? candidate.state === 'absent'
        : (candidate.state === 'value' || candidate.state === 'empty-string') &&
          candidate.value === to.value,
    )

    if (!group) {
      throw new BoardMoveError('target column is unavailable')
    }

    return group.key
  }

  private validateNeighbours(
    rows: ReturnType<ViewExecutionService['window']>['rows'],
    input: BoardMoveRequest,
  ): void {
    const ids = rows.map((row) => row.id).filter((id) => id !== input.cardId)
    const positions = new Map(ids.map((id, index) => [id, index]))

    if (input.beforeId && !positions.has(input.beforeId)) {
      throw new BoardMoveError('beforeId is not in the target column')
    }
    if (input.afterId && !positions.has(input.afterId)) {
      throw new BoardMoveError('afterId is not in the target column')
    }
    if (
      input.beforeId &&
      input.afterId &&
      positions.get(input.beforeId) !== positions.get(input.afterId)! + 1
    ) {
      throw new BoardMoveError('move neighbours are not adjacent')
    }
  }

  private validateFieldIntent(board: ResolvedBoard, input: BoardMoveRequest): void {
    if (
      !(board.prepared.rows as Array<{ id?: string }> | undefined)?.some(
        (row) => row.id === input.cardId,
      )
    ) {
      throw new BoardMoveError('card is no longer in the board source')
    }
    const target = this.targetGroup(board, input.to)

    this.validateNeighbours(this.rowsInGroup(board, target).rows, input)
  }

  private placement(
    rows: ReturnType<ViewExecutionService['window']>['rows'],
    input: BoardMoveRequest,
  ): Placement {
    this.validateNeighbours(rows, input)
    const ids = rows.map((row) => row.id).filter((id) => id !== input.cardId)
    const before = input.beforeId ? ids.indexOf(input.beforeId) : -1
    const after = input.afterId ? ids.indexOf(input.afterId) : -1
    const at = before >= 0 ? before : after >= 0 ? after + 1 : ids.length

    return {
      ...(ids[at - 1] ? { previousId: ids[at - 1] } : {}),
      ...(ids[at] ? { nextId: ids[at] } : {}),
    }
  }

  private partial(reason: PartialMove['reason']): PartialMove {
    return {
      status: 'moved-partial',
      fieldEffect: { key: '', value: null, versionToken: '' },
      reason,
    }
  }

  private async postFieldState(input: {
    store: KnowledgeStore
    original: ResolvedBoard
    viewRef: string
    cardId: string
    to: BoardMoveRequest['to']
    request: BoardMoveRequest
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
  }): Promise<ResolvedBoard | PartialMove> {
    let current: ResolvedBoard

    try {
      current = await this.resolve({
        store: input.store,
        viewRef: input.viewRef,
        projects: input.projects,
        schema: input.schema,
        allowNewToken: true,
      })
    } catch (error) {
      return this.partial(
        (error as { isNotFound?: boolean }).isNotFound ||
          (error as Error).message.includes('deleted')
          ? 'view-deleted'
          : 'view-changed',
      )
    }
    if (current.signature !== input.original.signature) {
      return this.partial('view-changed')
    }
    let target: string

    try {
      target = this.targetGroup(current, input.to)
    } catch {
      return this.partial('membership-changed')
    }
    const rows = this.rowsInGroup(current, target).rows

    if (!rows.some((row) => row.id === input.cardId)) {
      return this.partial('membership-changed')
    }
    try {
      this.validateNeighbours(rows, input.request)
    } catch {
      return this.partial('membership-changed')
    }

    return current
  }

  async move(input: {
    request: BoardMoveRequest
    store: KnowledgeStore
    space: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    fieldSchemaStore?: FieldSchemaStore
    principal?: string
  }): Promise<BoardMoveResponse> {
    const request = BoardMoveRequestSchema.parse(input.request)
    const decoded = decodeViewRef(request.viewRef)

    if (!decoded) {
      throw new BoardMoveError('stale viewRef')
    }
    let board = await this.resolve({
      store: input.store,
      viewRef: request.viewRef,
      projects: input.projects,
      schema: input.schema,
    })
    const groupField = board.groupField
    this.validateFieldIntent(board, request)
    let membership = await board.mutation.readMembership({
      store: input.store,
      cardId: request.cardId,
      fieldKey: groupField,
    })
    const targetValue = request.to.kind === 'value' ? request.to.value : null
    const currentValue = membership.value

    if (
      !request.beforeId &&
      !request.afterId &&
      (targetValue === null ? currentValue === undefined : currentValue === targetValue)
    ) {
      return {
        status: 'unchanged',
        cardVersionToken: membership.versionToken ?? '',
        viewVersionToken: board.note.versionToken ?? '',
      }
    }
    let cardVersionToken = ''
    let fieldWritten = false

    for (let attempt = 0; attempt < CARD_WRITE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        board = await this.resolve({
          store: input.store,
          viewRef: request.viewRef,
          projects: input.projects,
          schema: input.schema,
        })
      }
      this.validateFieldIntent(board, request)
      membership = await board.mutation.readMembership({
        store: input.store,
        cardId: request.cardId,
        fieldKey: groupField,
      })

      try {
        const result = await board.mutation.writeMembership({
          store: input.store,
          fieldSchemaStore: input.fieldSchemaStore,
          space: input.space,
          cardId: request.cardId,
          fieldKey: groupField,
          versionToken: membership.versionToken,
          value: targetValue,
          principal: input.principal,
        })

        cardVersionToken = result.versionToken
        fieldWritten = true
        break
      } catch (error) {
        if (
          !(error as { isConflict?: boolean }).isConflict ||
          attempt === CARD_WRITE_ATTEMPTS - 1
        ) {
          throw error
        }
      }
    }
    if (!fieldWritten) {
      throw new BoardMoveError('card field write did not complete')
    }
    const effect = { key: groupField, value: targetValue, versionToken: cardVersionToken }
    const post = await this.postFieldState({
      store: input.store,
      original: board,
      viewRef: request.viewRef,
      cardId: request.cardId,
      to: request.to,
      request,
      projects: input.projects,
      schema: input.schema,
    })

    if (!('signature' in post)) {
      return { ...post, fieldEffect: effect }
    }
    let rankBoard = post

    for (let attempt = 0; attempt < RANK_WRITE_ATTEMPTS; attempt++) {
      const currentViewRef = rankBoard.view.viewRef!

      try {
        const parsedRanks = parseBoardRanks(rankBoard.options.order.ranks)
        const group = this.targetGroup(rankBoard, request.to)
        const rows = this.rowsInGroup(rankBoard, group).rows
        const placement = this.placement(rows, request)
        const previousRank = placement.previousId
          ? parsedRanks.entries.get(placement.previousId)
          : null
        const nextRank = placement.nextId ? parsedRanks.entries.get(placement.nextId) : null
        let rebalanced =
          !parsedRanks.writable ||
          (placement.previousId !== undefined && previousRank === undefined) ||
          (placement.nextId !== undefined && nextRank === undefined)
        let rank: string | undefined

        if (!rebalanced) {
          rank = jitteredBoardRank(previousRank ?? null, nextRank ?? null, this.bits)
          rebalanced = rankNeedsRebalance(rank)
        }
        let patched: ReturnType<typeof putViewRank>

        if (rebalanced) {
          const allIds: string[] = []

          for (const candidate of rankBoard.prepared.groups ?? []) {
            const candidateRows = this.rowsInGroup(rankBoard, candidate.key).rows
            const ids = candidateRows.map((row) => row.id).filter((id) => id !== request.cardId)

            if (candidate.key === group) {
              const before = request.beforeId ? ids.indexOf(request.beforeId) : -1
              const after = request.afterId ? ids.indexOf(request.afterId) : -1
              const at = before >= 0 ? before : after >= 0 ? after + 1 : ids.length

              ids.splice(at, 0, request.cardId)
            }
            for (const id of ids) {
              allIds.push(id)
            }
          }
          const ranks = rebalanceBoardRanks(allIds)

          rank = ranks.get(request.cardId)
          patched = replaceViewRanks(
            rankBoard.note.content,
            rankBoard.parsed,
            currentViewRef,
            ranks,
          )
        } else {
          patched = putViewRank(
            rankBoard.note.content,
            rankBoard.parsed,
            currentViewRef,
            request.cardId,
            rank!,
          )
        }
        const result = await input.store.write({
          originalId: decoded.documentId,
          title: rankBoard.note.title ?? '',
          content: patched.content,
          versionToken: rankBoard.note.versionToken,
          ...(patched.viewType !== undefined ? { viewType: patched.viewType } : {}),
          derivedContentUnchanged: true,
          principal: input.principal,
        })

        return {
          status: 'moved',
          cardVersionToken,
          viewVersionToken: result.versionToken ?? '',
          rank: rank ?? '',
          ...(rebalanced ? { rebalanced: true } : {}),
        }
      } catch (error) {
        if (!(error as { isConflict?: boolean }).isConflict) {
          return {
            status: 'moved-unranked',
            cardVersionToken,
            viewVersionToken: rankBoard.note.versionToken ?? '',
            reason: 'rank-write-failed',
          }
        }
        const afterFailure = await this.postFieldState({
          store: input.store,
          original: rankBoard,
          viewRef: currentViewRef,
          cardId: request.cardId,
          to: request.to,
          request,
          projects: input.projects,
          schema: input.schema,
        })

        if (!('signature' in afterFailure)) {
          return { ...afterFailure, fieldEffect: effect }
        }
        rankBoard = afterFailure
      }
    }

    return {
      status: 'moved-unranked',
      cardVersionToken,
      viewVersionToken: rankBoard.note.versionToken ?? '',
      reason: 'rank-write-failed',
    }
  }
}
