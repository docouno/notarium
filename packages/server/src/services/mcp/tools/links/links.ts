// Graph link tools (link / link_many) + the shared resolveLinkTitle resolver.
// canon: docs/mcp-gateway.md#tools
import { type BatchLinkResult, type LinkInput, type LinkManyInput } from '@notarium/contract/tools'
import {
  encodeWikilinkAlias,
  encodeWikilinkIdentity,
  isWikilinkIdentityTarget,
  linkNotes,
  linkNotesMany,
  type LinkSpec,
  normalizeWikilinkTarget,
} from '@notarium/core'

import { type Ctx, type Handler, toolErrorMessage, ToolFailure } from '../../gateway'
import { mcpNoteMutationOptions, openMcpNoteDoor } from '../../helpers/noteDoor'
import { writeAttributionOf } from '../../helpers/writeAttribution'
import { sanitizeText } from '../../sanitize'

/** Resolve a link target (`to` id OR `toTitle` forward-ref) to the wikilink target we
 *  materialize — the one chokepoint shared by link, link_many and inline links.
 *  `fromId` omitted (inline links, source has no id yet) skips the self-link guard.
 *  canon: docs/core.md#graph-derivation */
export const resolveLinkTitle = async (
  ctx: Ctx,
  opts: { fromId?: string; fromSpace: string; relation: string; to?: string; toTitle?: string },
): Promise<string> => {
  const { relation, to, toTitle } = opts

  // A blank `relation` materializes a relation-less line; brackets/newlines break the
  // materialized line or inject a stray wikilink — reject both.
  if (relation.trim() === '') {
    throw new ToolFailure('`relation` must be a non-empty label (e.g. "depends_on").')
  }
  if (/[[\]\r\n]/.test(relation)) {
    throw new ToolFailure(
      '`relation` must be a simple label (e.g. "depends_on") without brackets or newlines.',
    )
  }
  const hasTo = to != null && to !== ''
  const hasToTitle = toTitle != null && toTitle !== ''

  if (hasTo === hasToTitle) {
    throw new ToolFailure(
      'provide exactly one of `to` (an existing note-id) or `toTitle` (a forward-reference by title).',
    )
  }
  let title: string

  if (hasToTitle) {
    // Forward-ref: materialized unresolved; same-space by construction, so no
    // cross-space check here.
    title = (toTitle as string).trim()
    if (!title) {
      throw new ToolFailure('`toTitle` must name a non-empty future note.')
    }
    if (isWikilinkIdentityTarget(title)) {
      throw new ToolFailure(
        '`toTitle` cannot use the reserved `notarium-id:` namespace. Pass an existing note through `to`, or use an ordinary future title.',
      )
    }
    // A forward title is useful only when the exact authored target is also the
    // resolver address of the note create_note will later create. In particular,
    // `.md` is storage syntax to the resolver but title text to nameKey, so accepting
    // `Future.md` would report success while leaving an immortal ghost behind.
    if (normalizeWikilinkTarget(title) !== title) {
      throw new ToolFailure(
        '`toTitle` cannot end in `.md` or otherwise normalize to a different wikilink target. Use the future note title without storage syntax.',
      )
    }
    // A forward reference is allowed to miss, but it must not already resolve
    // back to the source under any human address (title/path/slug/alias/plain id).
    // Such a self-loop is discarded by graph derivation, so reporting a successful
    // write would be a false edge. Existing-target `to` is guarded below.
    if (opts.fromId) {
      const store = await ctx.store.spaceStore(opts.fromSpace)

      if (store.resolveWikilink) {
        try {
          const resolved = await store.resolveWikilink(title)

          if ((resolved.id ?? title) === opts.fromId) {
            throw new ToolFailure('a note cannot be linked to itself.')
          }
        } catch (err) {
          if (!(err as { isNotFound?: boolean }).isNotFound) {
            throw err
          }
          // An honest miss is the intended forward-reference case.
        }
      }
    }
  } else {
    // A self-link makes no edge (the graph drops self-loops) — refuse it.
    if (opts.fromId && to === opts.fromId) {
      throw new ToolFailure('a note cannot be linked to itself.')
    }
    // One anti-enumeration null covers both a missing note and one the caller can't
    // read, so the cross-space message below only fires for a `to` already visible
    // (no existence leak).
    const hitTo = await openMcpNoteDoor(ctx, to as string, 'note:read')

    if (!hitTo) {
      throw new ToolFailure('no such note to link to, or you do not have access to it')
    }
    // v1: co-located links only; cross-space withheld (internal exfiltration).
    // canon: docs/mcp-gateway.md#security
    if (hitTo.space !== opts.fromSpace) {
      throw new ToolFailure(
        'Cross-space links are not supported yet — both notes must be in the same space.',
      )
    }
    const detail = hitTo.note
    const targetId = hitTo.noteId

    if (opts.fromId && targetId === opts.fromId) {
      throw new ToolFailure('a note cannot be linked to itself.')
    }
    const display = detail.title ?? (to as string)
    // Preserve the selected stable identity. Every resolver maps the id to its local
    // node key (id in the read-model/client, storage path in the bare engine); the
    // alias keeps authored Markdown readable and survives rename/namesake collisions.
    const address = encodeWikilinkIdentity(targetId)
    title = /[\r\n]/.test(display) ? address : `${address}|${encodeWikilinkAlias(display)}`
  }
  // The wikilink target IS the title, so a title with a wikilink metacharacter would
  // resolve to the wrong note (or a ghost) — fail safe rather than link elsewhere.
  if (!hasTo && /[[\]|#/\r\n]/.test(title)) {
    throw new ToolFailure(
      'The target note’s title contains a character that cannot be expressed as a wikilink (one of [ ] | # /). Rename it to link automatically.',
    )
  }

  return title
}

export const handleLink: Handler = async (ctx, rawArgs) => {
  const { from, to, toTitle, relation } = rawArgs as LinkInput
  // Unknown id, foreign space and tombstone all collapse to one 404 (anti-enumeration).
  const hitFrom = await openMcpNoteDoor(ctx, from, 'note:write')

  if (!hitFrom) {
    throw new ToolFailure('no such note to link from, or you do not have access to it')
  }
  const sourceId = hitFrom.noteId
  const title = await resolveLinkTitle(ctx, {
    fromId: sourceId,
    fromSpace: hitFrom.space,
    relation,
    to,
    toTitle,
  })
  const result = await linkNotes(
    hitFrom.store,
    {
      fromId: sourceId,
      toTitle: title,
      relation,
      ...writeAttributionOf(ctx),
    },
    mcpNoteMutationOptions,
  )
  const structured = { ok: true as const, versionToken: result.versionToken ?? '' }
  const aliasAt = title.indexOf('|')
  const display = aliasAt === -1 ? title : title.slice(aliasAt + 1)
  const markdown =
    `Linked note \`${result.id ?? from}\` → **${sanitizeText(display)}** ` +
    `(\`${sanitizeText(relation)}\`).`
  return { markdown, structured }
}

export const handleLinkMany: Handler = async (ctx, rawArgs) => {
  const { links } = rawArgs as LinkManyInput
  // Group by `from` so edges sharing a source note land in ONE write; the index map
  // preserves input order in the results.
  const groups = new Map<string, number[]>()

  for (let i = 0; i < links.length; i++) {
    const arr = groups.get(links[i].from) ?? []
    arr.push(i)
    groups.set(links[i].from, arr)
  }
  const byIndex = new Map<number, BatchLinkResult>()
  const fail = (i: number, err: unknown) =>
    byIndex.set(i, { index: i, ok: false, error: sanitizeText(toolErrorMessage(err, 'link_many')) })

  for (const [from, indices] of groups) {
    let hitFrom: Awaited<ReturnType<typeof openMcpNoteDoor>>

    try {
      hitFrom = await openMcpNoteDoor(ctx, from, 'note:write')
    } catch (err) {
      for (const i of indices) {
        fail(i, err)
      }
      continue
    }

    if (!hitFrom) {
      const err = new ToolFailure('no such note to link from, or you do not have access to it')

      for (const i of indices) {
        fail(i, err)
      }
      continue
    }
    const sourceId = hitFrom.noteId
    const specs: LinkSpec[] = []
    const valid: number[] = []

    for (const i of indices) {
      const item = links[i]

      try {
        const title = await resolveLinkTitle(ctx, {
          fromId: sourceId,
          fromSpace: hitFrom.space,
          relation: item.relation,
          to: item.to,
          toTitle: item.toTitle,
        })
        specs.push({ toTitle: title, relation: item.relation })
        valid.push(i)
      } catch (err) {
        fail(i, err)
      }
    }
    if (!specs.length) {
      continue
    }
    try {
      const r = await linkNotesMany(
        hitFrom.store,
        {
          fromId: sourceId,
          links: specs,
          ...writeAttributionOf(ctx),
        },
        mcpNoteMutationOptions,
      )

      for (const i of valid) {
        byIndex.set(i, { index: i, ok: true, versionToken: r.versionToken ?? '' })
      }
    } catch (err) {
      // Best-effort across groups, atomic within one source note's single write.
      // canon: docs/mcp-gateway.md#limits
      for (const i of valid) {
        fail(i, err)
      }
    }
  }
  const results: BatchLinkResult[] = links.map(
    (_, i) => byIndex.get(i) ?? { index: i, ok: false, error: 'internal error' },
  )
  const ok = results.filter((r) => r.ok).length
  const failed = results.length - ok
  const markdown =
    `Linked ${ok} of ${links.length} edge${links.length === 1 ? '' : 's'}` +
    `${failed ? ` — ${failed} failed (see results)` : ''}.`
  return { markdown, structured: { results } }
}
