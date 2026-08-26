import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@notarium/contract/tools'

import { SYSTEM_PRINCIPAL } from '../../../../services/authz'
import { TOOL_META } from '../../../../services/mcp/descriptions'
import type { McpGateway } from '../../../../services/mcp/gateway'
import { buildServer } from './transport'

describe('MCP SDK tool registration', () => {
  const clients: Client[] = []
  const servers: ReturnType<typeof buildServer>[] = []

  afterEach(async () => {
    await Promise.all([
      ...clients.map((client) => client.close()),
      ...servers.map((server) => server.close()),
    ])
    clients.length = 0
    servers.length = 0
  })

  it('rejects unknown arguments before invoking the gateway callback', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: {
        principal: 'system',
        scope: 'write',
        projects: [],
        capabilities: { vector: false, trash: true, revisions: true },
      },
    }))
    const gateway = {
      listTools: () => [
        {
          name: 'whoami' as const,
          description: TOOL_META.whoami.description,
          annotations: TOOL_META.whoami.annotations,
          input: tools.whoami.input,
          output: tools.whoami.output,
        },
      ],
      callTool,
    } satisfies McpGateway
    const server = buildServer(gateway, SYSTEM_PRINCIPAL)
    const client = new Client({ name: 'contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    servers.push(server)
    clients.push(client)
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: 'whoami',
      arguments: { __unknown__: true },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringMatching(/invalid arguments/i) }),
    ])
    expect(callTool).not.toHaveBeenCalled()
  })
})
