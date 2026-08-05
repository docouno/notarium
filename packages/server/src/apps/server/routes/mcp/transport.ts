import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
// The MCP wire adapter: the @modelcontextprotocol/sdk drives the JSON-RPC
// envelope + handshake; the gateway (services/mcp/gateway) supplies tools + policy.
// A dedicated POST /mcp, self-authenticating (installAuthz guards only /api) and
// stateless (fresh server per request, scoped to the authenticated principal).
// canon: docs/mcp-gateway.md#connect · docs/mcp-oauth.md#surfaces
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AUTH_MODE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import type { InteractiveSignal } from '@notarium/core'

import type { MutationGate } from '../../../../libs/mutationGate'
import type { AuthService } from '../../../../services/auth'
import { type Principal, SYSTEM_PRINCIPAL } from '../../../../services/authz'
import { SERVER_INFO, SERVER_INSTRUCTIONS } from '../../../../services/mcp/descriptions'
import { createGateway, type McpGateway } from '../../../../services/mcp/gateway'
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
import type { SpaceManager } from '../../../../services/spaces'
import { baseUrlOf, wwwAuthenticateChallenge } from '../oauth'

export type McpOptions = {
  spaces: SpaceManager
  auth: AuthService
  sessions?: AgentSessionsPersistence
  agentDeltaCursors?: AgentDeltaCursorsPersistence
  gatewayState?: GatewayStatePersistence
  /** Absent ⇒ no retrieval audit capture (P5 honest degradation).
   *  canon: docs/projects.md#audit-auditing-the-runtime-retrieval-243-mem-audita */
  retrievalLog?: RetrievalLogPersistence
  projects?: ProjectsPersistence
  /** Absent on a host without a meta-DB / marker FS ⇒ container-reorg tools off (P5). */
  folders?: FolderIdentityPersistence
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
  markerStore?: MarkerStore
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

/** Per-request MCP server exposing only the tools this principal may see (the
 *  scope filter), each delegating to the gateway. canon: docs/mcp-gateway.md#security */
const buildServer = (
  gateway: McpGateway,
  principal: Principal,
  mutationGate?: MutationGate,
): McpServer => {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS })

  for (const t of gateway.listTools(principal)) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.input.shape,
        // The SDK re-validates structuredContent against this on success (skipped on
        // isError); the gateway already validated the same shape — a second, wire-
        // published guard, never a new failure mode.
        outputSchema: t.output.shape,
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

/** Register the `/mcp` endpoint on the host. Call before the SPA fallback. */
export const registerMcp = async (
  app: FastifyInstance,
  {
    spaces,
    auth,
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
    oauthChallenge,
    publicBaseUrl,
    scheduler,
    mutationGate,
  }: McpOptions,
): Promise<void> => {
  const gateway = createGateway({
    spaces,
    auth,
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
      principal = authed.principal
    }

    const server = buildServer(gateway, principal, mutationGate)
    const transport = new StreamableHTTPServerTransport({
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
    // Once we hijack, Fastify's error handler is bypassed — so an unexpected throw
    // must be caught here, or the agent hangs with no reply.
    reply.hijack()
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      console.error('[mcp] handleRequest ->', (err as Error)?.message)
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
