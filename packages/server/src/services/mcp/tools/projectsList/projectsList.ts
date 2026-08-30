// whoami + get_my_projects MCP tools. canon: docs/mcp-gateway.md#tools
import { agentOwnerOf } from '../../../authz'
import { type Ctx, type Handler } from '../../gateway'
import { sanitizeText } from '../../sanitize'

export const handleWhoami: Handler = async (ctx) => {
  const [projects, capabilities, hasModel] = await Promise.all([
    ctx.readableProjects(),
    hostCapabilities(ctx),
    principalHasModel(ctx),
  ])
  // Wire scope is read|write only; any non-read scope (e.g. a management session) collapses to write.
  const scope: 'read' | 'write' = ctx.principal.scope === 'read' ? 'read' : 'write'
  const structured = {
    principal: ctx.principal.id,
    scope,
    projects: projects.map((p) => ({ ...p, displayName: sanitizeText(p.displayName) })),
    capabilities,
    hasModel,
  }
  const caps = Object.entries(capabilities)
    .filter(([, on]) => on)
    .map(([k]) => k)
  const lines = [
    `You are \`${ctx.principal.id}\` with **${scope}** access.`,
    caps.length ? `Engine capabilities: ${caps.join(', ')}.` : 'Engine capabilities: none.',
    `Model available: ${hasModel ? 'yes' : 'no'}.`,
    '',
    projects.length
      ? `Projects you can reach:\n${projects.map((p) => `- \`${p.handle}\` — ${sanitizeText(p.displayName)}`).join('\n')}`
      : 'You have no project workspaces yet.',
  ]
  return { markdown: lines.join('\n'), structured }
}

const principalHasModel = async (ctx: Ctx): Promise<boolean> => {
  const owner = agentOwnerOf(ctx.principal)

  if (!ctx.providerRegistry || !owner) {
    return false
  }

  return ctx.providerRegistry.hasUsableForPrincipal({
    owner,
    spaces: await ctx.readableSpaces(),
  })
}

/** Host engine capabilities probed off any reachable space — one engine kind per host, so any store answers alike. */
const hostCapabilities = async (
  ctx: Ctx,
): Promise<{ vector: boolean; trash: boolean; revisions: boolean }> => {
  const spaceId = (await ctx.readableSpaces())[0]

  if (!spaceId) {
    return { vector: false, trash: false, revisions: false }
  }
  const caps = (await ctx.spaces.store(spaceId)).capabilities
  return { vector: caps.vector, trash: caps.trash, revisions: caps.revisions }
}

export const handleGetMyProjects: Handler = async (ctx) => {
  const projects = await ctx.readableProjects()
  const structured = {
    projects: projects.map((p) => ({ ...p, displayName: sanitizeText(p.displayName) })),
  }
  const markdown = projects.length
    ? `Your projects:\n${structured.projects.map((p) => `- \`${p.handle}\` — ${p.displayName}`).join('\n')}`
    : 'You have no project workspaces yet.'
  return { markdown, structured }
}
