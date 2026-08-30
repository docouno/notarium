import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node'
import {
  classifyInboundRequest,
  createMcpHandler,
  isLegacyRequest,
  isSpecType,
  McpServer,
} from '@modelcontextprotocol/server'
// The MCP wire adapter: the official MCP packages drive the JSON-RPC
// envelope + handshake; the gateway (services/mcp/gateway) supplies tools + policy.
// A dedicated POST /mcp, self-authenticating (installAuthz guards only /api) and
// stateless (fresh server per request, scoped to the authenticated principal).
// canon: docs/mcp-gateway.md#connect · docs/mcp-oauth.md#surfaces
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AUTH_MODE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import type { InteractiveSignal } from '@notarium/core'

import type { MutationGate } from '../../../../libs/mutationGate'
import { isCrossOrigin } from '../../../../libs/requestOrigin'
import type { AbilitiesService } from '../../../../services/abilities'
import type { AuthService } from '../../../../services/auth'
import { type Principal, SYSTEM_PRINCIPAL } from '../../../../services/authz'
import type { FieldSchemaStore } from '../../../../services/fields'
import {
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  type ToolAnnotations,
} from '../../../../services/mcp/descriptions'
import { createGateway, type McpGateway, type ToolResult } from '../../../../services/mcp/gateway'
import type {
  AgentDeltaCursorsPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  FolderIdentityPersistence,
  GatewayStatePersistence,
  ProjectsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../../../../services/metaDb'
import type { MarkerStore } from '../../../../services/projects'
import type { RolesService } from '../../../../services/roles'
import type { SpaceManager } from '../../../../services/spaces'
import { baseUrlOf, wwwAuthenticateChallenge } from '../oauth'

export type McpOptions = {
  spaces: SpaceManager
  auth: AuthService
  roles?: RolesService
  abilities?: AbilitiesService
  sessions?: AgentSessionsPersistence
  agentDeltaCursors?: AgentDeltaCursorsPersistence
  gatewayState?: GatewayStatePersistence
  /** Absent ⇒ no retrieval audit capture (P5 honest degradation).
   *  canon: docs/projects.md#activity-auditing-agent-work-243-321-mem-audita */
  retrievalLog?: RetrievalLogPersistence
  projects?: ProjectsPersistence
  /** Absent on a host without a meta-DB / marker FS ⇒ container-reorg tools off (P5). */
  folders?: FolderIdentityPersistence
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
  markerStore?: MarkerStore
  fieldSchemaStore?: FieldSchemaStore
  /** On ⇒ an unauthenticated /mcp answers 401 with the RFC 9728 WWW-Authenticate
   *  challenge; off ⇒ a plain 401. */
  oauthChallenge?: boolean
  /** Absent → the challenge URLs are derived per-request from forwarded headers
   *  (trusted-proxy assumption). canon: docs/mcp-oauth.md#security */
  publicBaseUrl?: string
  /** Bracket a tool call as interactive work (embed-backfill yields to MCP traffic).
   *  Counted HERE, not by onResponse — the handler hijacks the reply, so the hook
   *  would never balance. Absent ⇒ uncounted. canon: docs/core.md#cooperative */
  scheduler?: InteractiveSignal
  /** Tool calls enter the online-backup barrier because read tools may persist
   *  session delta cursors or retrieval-audit rows too. */
  mutationGate?: MutationGate
}

type RegisterGatewayTool = (
  name: string,
  config: {
    description: string
    inputSchema: unknown
    outputSchema: unknown
    annotations: ToolAnnotations
  },
  callback: (args: unknown) => Promise<ToolResult>,
) => void

const MODERN_PROTOCOL_VERSION = '2026-07-28'
const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen'

const publishableSchema = (
  runtime: z.ZodTypeAny,
  published: z.ZodTypeAny,
  io: 'input' | 'output',
) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'notarium-zod',
    validate: async (value: unknown) => {
      const parsed = await runtime.safeParseAsync(value)

      return parsed.success
        ? { value: parsed.data }
        : {
            issues: parsed.error.issues.map((issue) => ({
              message: issue.message,
              path: issue.path,
            })),
          }
    },
    jsonSchema: {
      input: () => z.toJSONSchema(published, { io }),
      output: () => z.toJSONSchema(published, { io }),
    },
  },
})

/** Per-request MCP server exposing only the tools this principal may see (the
 *  scope filter), each delegating to the gateway. canon: docs/mcp-gateway.md#security */
export const buildServer = (
  gateway: McpGateway,
  principal: Principal,
  mutationGate?: MutationGate,
): McpServer => {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: { listChanged: false } },
    cacheHints: {
      'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
      'server/discover': { ttlMs: 300_000, cacheScope: 'private' },
    },
  })
  // The SDK's recursive schema-output generic exceeds TypeScript's instantiation
  // limit over the dynamic registry union. This call surface preserves the SDK's
  // runtime contract while keeping the callback boundary deliberately unknown.
  const registerTool = server.registerTool.bind(server) as unknown as RegisterGatewayTool

  for (const t of gateway.listTools(principal)) {
    // The runtime values remain the complete strict Zod objects.
    const inputSchema = t.publishedInput
      ? publishableSchema(t.input, t.publishedInput, 'input')
      : t.input
    const outputSchema = t.publishedOutput
      ? publishableSchema(t.output, t.publishedOutput, 'output')
      : t.output

    registerTool(
      t.name,
      {
        description: t.description,
        inputSchema,
        // The SDK re-validates structuredContent against this on success (skipped on
        // isError); the gateway already validated the same schema — a second, wire-
        // published guard, never a new failure mode.
        outputSchema,
        annotations: t.annotations,
      },
      async (args: unknown) => {
        const call = () => gateway.callTool(principal, t.name, args)

        return mutationGate ? mutationGate.run(call) : call()
      },
    )
  }

  return server
}

const modernSubscriptionId = (
  inbound: ReturnType<typeof classifyInboundRequest>,
  mcpMethodHeader: string | undefined,
): string | number | undefined => {
  if (
    inbound.kind !== 'modern' ||
    inbound.messageKind !== 'request' ||
    inbound.classification.era !== 'modern' ||
    inbound.classification.revision !== MODERN_PROTOCOL_VERSION ||
    inbound.message.method !== SUBSCRIPTIONS_LISTEN_METHOD ||
    mcpMethodHeader !== inbound.message.method ||
    !isSpecType.SubscriptionsListenRequest(inbound.message)
  ) {
    return undefined
  }

  return inbound.message.id
}

/** Register the `/mcp` endpoint on the host. Call before the SPA fallback. */
export const registerMcp = async (
  app: FastifyInstance,
  {
    spaces,
    auth,
    roles,
    abilities,
    sessions,
    agentDeltaCursors,
    gatewayState,
    retrievalLog,
    projects,
    folders,
    contextSets,
    scopePins,
    contextOrder,
    markerStore,
    fieldSchemaStore,
    oauthChallenge,
    publicBaseUrl,
    scheduler,
    mutationGate,
  }: McpOptions,
): Promise<void> => {
  const gateway = createGateway({
    spaces,
    auth,
    roles,
    abilities,
    sessions,
    agentDeltaCursors,
    gatewayState,
    retrievalLog,
    projects,
    folders,
    contextSets,
    scopePins,
    contextOrder,
    markerStore,
    fieldSchemaStore,
    runMutation: mutationGate ? (task) => mutationGate.run(task) : undefined,
  })

  /** 401 carrying the RFC 9728 WWW-Authenticate challenge when the OAuth facade is on. */
  const challenge401 = (req: FastifyRequest, reply: FastifyReply) => {
    if (oauthChallenge) {
      reply.header('www-authenticate', wwwAuthenticateChallenge(baseUrlOf(req, publicBaseUrl)))
    }

    return reply
      .code(HTTP_STATUS.UNAUTHORIZED)
      .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })
  }

  const handlePost = async (req: FastifyRequest, reply: FastifyReply) => {
    let principal: Principal

    if (auth.mode === AUTH_MODE.none) {
      principal = SYSTEM_PRINCIPAL
    } else {
      const authed = await auth.authenticate(req.headers)

      if (!authed) {
        return challenge401(req, reply)
      }
      // Cookie mutations get the same second CSRF line REST has (belt over SameSite=Lax).
      // A bearer cred carries no cookie, so it is never cross-origin here.
      // canon: docs/auth.md#csrf-and-proxy
      if (authed.viaCookie && isCrossOrigin(req)) {
        return reply.code(HTTP_STATUS.FORBIDDEN).send({
          jsonrpc: '2.0',
          error: { code: -32003, message: 'cross-origin request rejected' },
          id: null,
        })
      }
      principal = authed.principal
    }

    let hijacked = false

    try {
      const probe = await toWebRequest(req.raw, req.body)
      const legacy = await isLegacyRequest(probe)

      if (!legacy) {
        const mcpMethodHeader = probe.headers.get('mcp-method') ?? undefined
        const inbound = classifyInboundRequest({
          httpMethod: probe.method,
          protocolVersionHeader: probe.headers.get('mcp-protocol-version') ?? undefined,
          mcpMethodHeader,
          mcpNameHeader: probe.headers.get('mcp-name') ?? undefined,
          body: req.body,
        })
        const subscriptionId = modernSubscriptionId(inbound, mcpMethodHeader)

        if (subscriptionId !== undefined) {
          return reply.code(HTTP_STATUS.NOT_FOUND).send({
            jsonrpc: '2.0',
            id: subscriptionId,
            error: { code: -32601, message: 'Method not found' },
          })
        }
      }

      // Both transports write directly to the Node response. Once hijacked,
      // every unexpected throw must be handled here or the agent hangs.
      reply.hijack()
      hijacked = true

      if (legacy) {
        const server = buildServer(gateway, principal, mutationGate)
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: one pair per request
          enableJsonResponse: true,
        })
        // Transport-level errors (socket/protocol) would otherwise vanish — log them.
        transport.onerror = (err) => console.error('[mcp] transport ->', err.message)
        reply.raw.on('close', () => {
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req.raw, reply.raw, req.body)
        return
      }

      const handler = createMcpHandler(() => buildServer(gateway, principal, mutationGate), {
        legacy: 'reject',
        responseMode: 'auto',
        onerror: (err) => console.error('[mcp] handler ->', err.message),
      })
      const handleModern = toNodeHandler(handler, {
        onerror: (err) => console.error('[mcp] adapter ->', err.message),
      })
      await handleModern(req.raw, reply.raw, req.body)
    } catch (err) {
      console.error('[mcp] handleRequest ->', (err as Error)?.message)
      if (!hijacked) {
        return reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        })
      }
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        )
      } else if (!reply.raw.writableEnded) {
        reply.raw.end()
      }
    }
  }

  app.route({
    method: 'POST',
    url: '/mcp',
    // longLived: the handler hijacks the reply → onResponse never fires; this flag
    // excludes /mcp from the app's onResponse interactive-count balancing (counted
    // in the handler instead).
    config: { longLived: true },
    handler: async (req, reply) => {
      scheduler?.enterInteractive()
      try {
        await handlePost(req, reply)
      } finally {
        scheduler?.exitInteractive()
      }
    },
  })

  // No server-initiated streams here: GET (open stream) and DELETE (close session)
  // → 405. Declared so they don't fall through to the SPA index.html.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(HTTP_STATUS.METHOD_NOT_ALLOWED)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: use POST' },
        id: null,
      })
  app.route({ method: 'GET', url: '/mcp', handler: methodNotAllowed })
  app.route({ method: 'DELETE', url: '/mcp', handler: methodNotAllowed })
}
