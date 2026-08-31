import { createHash } from 'node:crypto'
import {
  AGENT_CALL_OUTCOME,
  AGENT_CALL_TRANSPORT,
  AGENT_TRACE_PROJECTION_VERSION,
  type AgentCallOutcome,
} from '@notarium/contract'
import type { ToolName } from '@notarium/contract/tools'
import { freshNoteId } from '@notarium/core'

import type { BoundAgentSession } from '../agentSessions'
import type { Principal } from '../authz'
import { agentOwnerOf } from '../authz'
import type { AgentCallTracePersistence, AgentTraceJson } from '../metaDb'
import {
  fingerprintOf,
  inputShapeOf,
  issueSummaryOf,
  TRACE_TOOL_POLICY,
  traceInputOf,
  type TraceIssue,
  traceResultOf,
} from './traceProjectors'

export type AgentCallSpan = {
  id: string
  owner: string
  tool: string
  knownTool: ToolName | null
  startedAt: string
  inputShape: AgentTraceJson
  detailInput: AgentTraceJson
  detailedEnabled: boolean
  compactRetentionDays: number
  detailedRetentionDays: number
  redacted: boolean
  truncated: boolean
  discarded: boolean
}

export type AgentCalls = {
  begin(
    principal: Principal,
    tool: string,
    input: unknown,
    requestId?: string | number,
  ): Promise<AgentCallSpan | null>
  projectInput(span: AgentCallSpan | null, input: unknown): Promise<void>
  bind(span: AgentCallSpan | null, session: BoundAgentSession | undefined): Promise<void>
  finish(
    span: AgentCallSpan | null,
    input: {
      outcome: AgentCallOutcome
      reasonCode?: string
      output?: unknown
      issues?: readonly TraceIssue[]
    },
  ): Promise<void>
}

export type CreateAgentCallsOptions = {
  persistence: AgentCallTracePersistence
  now?: () => Date
  mintId?: () => string
  onChange?: (owner: string) => void
}

const jsonBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}

const requestIdOf = (value: string | number | undefined): string | null => {
  if (value == null) {
    return null
  }
  const text = String(value)
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text)
    ? text
    : `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
}

const addDays = (date: Date, days: number): string =>
  new Date(date.getTime() + days * 86_400_000).toISOString()

export const createAgentCalls = ({
  persistence,
  now = () => new Date(),
  mintId = () => `call_${freshNoteId()}`,
  onChange,
}: CreateAgentCallsOptions): AgentCalls => {
  return {
    begin: async (principal, tool, input, requestId) => {
      const owner = agentOwnerOf(principal)

      if (!owner) {
        return null
      }
      const started = now()

      const knownTool = Object.hasOwn(TRACE_TOOL_POLICY, tool) ? (tool as ToolName) : null
      const config = await persistence.config()
      const shape = inputShapeOf(input, knownTool)
      const effect = knownTool ? TRACE_TOOL_POLICY[knownTool].effect : 'control'
      const domain = knownTool ? TRACE_TOOL_POLICY[knownTool].domain : 'unknown'
      const id = mintId()
      const fingerprint = fingerprintOf(tool, shape.shape, null)

      await persistence.admit({
        id,
        owner,
        principal: principal.id,
        agent: principal.label ?? null,
        transport: AGENT_CALL_TRANSPORT.mcp,
        requestId: requestIdOf(requestId),
        tool: tool.slice(0, 256),
        effect,
        domain,
        startedAt: started.toISOString(),
        inputBytes: jsonBytes(input),
        inputShape: shape.shape,
        targetSummary: null,
        fingerprint,
        projectionVersion: AGENT_TRACE_PROJECTION_VERSION,
        redacted: true,
        truncated: shape.truncated,
      })
      return {
        id,
        owner,
        tool,
        knownTool,
        startedAt: started.toISOString(),
        inputShape: shape.shape,
        detailInput: {},
        detailedEnabled: config.detailedEnabled,
        compactRetentionDays: config.compactRetentionDays,
        detailedRetentionDays: config.detailedRetentionDays,
        redacted: true,
        truncated: shape.truncated,
        discarded: false,
      }
    },

    projectInput: async (span, input) => {
      if (!span || !span.knownTool || span.discarded) {
        return
      }
      const projected = traceInputOf(span.knownTool, input, span.detailedEnabled)
      const stored = await persistence.projectInput(
        span.owner,
        span.id,
        projected.compact,
        projected.redacted,
        projected.truncated,
      )

      if (!stored) {
        span.discarded = true
        return
      }
      span.detailInput = projected.detail
      span.redacted = projected.redacted
      span.truncated ||= projected.truncated
    },

    bind: async (span, session) => {
      if (!span || !session || span.discarded) {
        return
      }
      const bound = await persistence.bind(span.owner, span.id, {
        id: session.record.id,
        name: session.record.name,
        attach: session.attach,
      })

      if (!bound) {
        span.discarded = true
        await persistence.discard(span.owner, span.id)
      }
    },

    finish: async (span, input) => {
      if (!span || span.discarded) {
        return
      }
      const finished = now()
      const issues = input.issues?.length ? issueSummaryOf(input.issues, span.knownTool) : null
      const result = span.knownTool
        ? traceResultOf(span.knownTool, input.output, span.detailedEnabled)
        : { compact: null, detail: null, redacted: true, truncated: false }
      span.redacted ||= result.redacted
      span.truncated ||= result.truncated
      let detailCaptureFailed = false

      if (span.detailedEnabled) {
        try {
          const stored = await persistence.appendDetail({
            owner: span.owner,
            id: span.id,
            payload: {
              input: span.detailInput,
              result: result.detail,
              ...(issues ? { issues } : {}),
            },
            createdAt: finished.toISOString(),
            expiresAt: addDays(finished, span.detailedRetentionDays),
          })

          if (!stored) {
            span.discarded = true
          }
        } catch {
          detailCaptureFailed = true
        }
      }
      if (span.discarded) {
        return
      }
      const finalized = await persistence.finalize(span.owner, span.id, {
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - Date.parse(span.startedAt)),
        outcome: input.outcome,
        reasonCode: input.reasonCode ?? null,
        outputBytes: input.output === undefined ? null : jsonBytes(input.output),
        issueSummary: issues,
        resultSummary: result.compact,
        fingerprint: fingerprintOf(span.tool, span.inputShape, issues),
        redacted: span.redacted,
        truncated: span.truncated,
        detailCaptureFailed,
      })

      if (finalized) {
        try {
          onChange?.(span.owner)
        } catch {
          // Owner invalidation is best-effort after the terminal row commits.
        }
      }
    },
  }
}

export const internalAgentCallOutcome = AGENT_CALL_OUTCOME.internalError
