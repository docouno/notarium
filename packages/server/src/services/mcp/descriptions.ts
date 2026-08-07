// Static agent-facing tool metadata (descriptions + MCP annotation hints) for the
// gateway; the wire schema lives separately in @notarium/contract/tools.
// SECURITY: these are STATIC literals — never reflect untrusted note content into
// a description or the server `instructions` (the tool-poisoning vector).
// TOOL_META is the gateway's registry: a tool absent here is not surfaced.
// canon: docs/mcp-gateway.md#security

/** MCP tool annotations — a structural subset of the SDK's ToolAnnotations, kept
 *  local so the gateway stays SDK-agnostic. `openWorldHint` is false on EVERY
 *  tool: Notarium has no outbound channel, so surfacing one would complete the
 *  "lethal trifecta". */
export type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type ToolMeta = {
  description: string
  annotations: ToolAnnotations
}

/** Per-tool agent-facing metadata; descriptions are written "as for a new
 *  employee" — what it does, when to use it, when NOT to. */
export const TOOL_META = {
  start_session: {
    description:
      "Call this FIRST in a new session. When the host supports agent episodes, it opens or resumes one and may return `session.id`; KEEP a returned id and pass it as the top-level `session` argument on every later tool call. Address by id to resume exactly, or by a non-unique human name: a sleeping match resumes, an active match forks and inherits its selected role, and ambiguous matches return matching choices without binding a session. Loads the user's profile and only the roles they explicitly added — the built-in catalog is never enabled automatically. When one role clearly matches, call `use_role`; or pass canonical `role` here to receive and activate it in this same call (`name` is a compatibility alias). Resuming an episode reloads its saved effective role so a fresh model context receives the instructions again. With a `project` hint the response also carries its compact index, pinned notes, delta and vocabulary, and resolves Project > Space > Personal role overrides. `acknowledge:false` peeks without advancing. Large context bundles are truncated honestly (`truncated:true`) — fall back to list_notes/search; abbreviated or omitted role summaries use `rolesTruncated:true` and continue with `list_roles`.",
    annotations: {
      title: 'Start session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  list_roles: {
    description:
      'Page through every role the human explicitly added and that is effective in the current Personal/Space/Project context. Use it when start_session reports rolesTruncated or when you need to discover beyond its compact role summaries. Pass the same project handle as start_session/use_role so Project > Space > Personal precedence matches. The built-in catalog is never listed because catalog availability does not make a role effective.',
    annotations: {
      title: 'List added roles',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  use_role: {
    description:
      'Activate one role already added to the current Personal/Space/Project scope and load its instructions, linked skills, role context, and an authoritative replacement for the base context previously returned by start_session. Refs omitted from that replacement are evicted by the shared Role → Project → Personal budget. Use canonical `role`; `name` is a compatibility alias. Pass the same `project` handle used for start_session so project and space overrides resolve correctly. A repeated name is an idempotent already-active success but is resolved and loaded again because a narrower project or space fork may now win. A catalog-only or unknown role is not activated and returns the roles actually available; adding catalog templates is an explicit human action in Notarium.',
    annotations: {
      title: 'Use an added role',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  whoami: {
    description:
      'Who am I and what am I allowed to do. Returns your principal id, your access ceiling (read or write), the project workspaces you belong to, and `capabilities` — what this host engine supports (`vector` = semantic search, not just keyword; `trash` = delete is recoverable; `revisions` = history/provenance/delta are available). Use when unsure about your access — for example before a write, to confirm you have a writable project — and read `capabilities` to tailor your plan instead of probing.',
    annotations: {
      title: 'Who am I',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_my_projects: {
    description:
      'List the project workspaces you can access, each with a `handle` (pass it verbatim into other tools — do not construct one), a display name, and the space it lives in. Use before a write to pick the right project. Your personal domain is not in this list: it is implied from your token (use remember_about_user for personal memory, which always lands there).',
    annotations: {
      title: 'My projects',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_notes: {
    description:
      'List the notes and subfolders directly inside a folder — an `ls` for the knowledge base, deterministic and paginated. Use it to see what is actually in a place (dedup before writing, "show me folder X", browse a project) rather than guessing with search. `project` (a handle from get_my_projects) picks the workspace and scopes to it; `path` is a SPACE-relative folder — copy one verbatim from a `folders` entry or a hit\'s `path` to drill in (do not construct paths). Omit `path` to list the project (or personal-domain) root. `tag` keeps only notes carrying that tag. Returns `items` (the folder\'s direct notes, with their id/title/path/tags) and `folders` (its direct subfolders, each with a subtree note count), plus an honest `total`; page further with the `cursor`/`nextCursor`. (A `tag` filter is exact for the first ~1000 notes of a single folder — deeper than that, narrow with search.) Lists your user-visible notes (not agent-memory — use search for that).',
    annotations: {
      title: 'List notes in a folder',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  recent_activity: {
    description:
      'Show the most recently changed notes — absolute freshness ("what was touched lately, I should review it"), drawn from the history journal. This is NOT the same as start_session\'s delta: that delta follows one bound durable session, or the owner fallback when no session is bound. recent_activity ignores either cursor and shows the latest changes regardless of the caller. `project` (a handle) narrows to that project; omit it for the latest across everything you can reach. `limit` caps how many. Each entry reports who changed it (`principal` — a person or an agent), how (`kind`), where (`path`/`project`), and when (`modifiedAt`). `truncated:true` means there was more than fit.',
    annotations: {
      title: 'Recent activity',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  search: {
    description:
      'Search across your knowledge AND your own agent-memory — searching now COVERS the memory you record with remember_* (so "search before write" finally dedups memory, not just notes). ALWAYS search before writing — it is how you avoid duplicates. `project` (a handle from get_my_projects) narrows to that project\'s notes and its memory; omit it to search everything you can reach. `class` filters by kind — pass `agent-memory` to search only your own memory, or `user-doc` to exclude it. Returns ranked snippets with a relevance `score`, not full notes — follow up with get_note for the full content. Each hit reports where it lives: `path` (its folder/file — for talking folders with a human), no `space` means your personal domain, and `project` is the marked project it belongs to (absent if none).',
    annotations: {
      title: 'Search knowledge',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_note: {
    description:
      'Read a full note by its id (the `noteId` from search). Returns the content, frontmatter, `path` (where it lives — for speaking folders with a human; you still reference notes by id, not path), and a `versionToken` — pass that token back to edit_note to write safely without clobbering a concurrent edit. A detailed read (the default) also returns `outline` (the note\'s headings — the menu of valid `section` names for edit_note\'s replaceSection) and `links` (its graph edges: `outgoing` and `incoming`, each with the connected note — for reorganising and seeing "what points here"; in v1 the `relation` is the graph link type, not the authored label). Also returns `provenance` — who last edited it (a person or an agent), how, and when. Identifiers are note-ids, stable across rename and move.',
    annotations: {
      title: 'Read a note',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  recall: {
    description:
      'Assemble a token-budgeted context bundle around a topic: the most relevant notes PLUS their graph neighbours (`depth` hops). Use this for "what do we know about X" before starting a task — it is richer than search, which only lists matches. With a `project` handle it narrows to THAT project alone — its notes and the memory you recorded about it. Omit `project` to draw from everything you can reach, INCLUDING the memory you keep about the user. `budgetTokens` caps the size of the returned context. The result is ready-to-read context, with `sources` listing the notes it was built from (each labelled by where it lives).',
    annotations: {
      title: 'Recall context',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  remember_about_user: {
    description:
      'Record a durable fact about the USER (preferences, context, ongoing work) into their private agent-memory. Appends as a readable observation under a memory `category` (a label like "preferences" — pick or reuse one; do NOT pass a path). Optional `summary` is a one-line digest of the category that feeds the user\'s profile — passing it OVERWRITES the existing summary (the response\'s `summaryUpdated` tells you which happened); omit it to keep the current one. The response also reports `outcome` (`created` a new category, `appended` to an existing one, or `skipped` on an idempotencyKey replay). Pass `idempotencyKey` to make a retry safe — WITHOUT one a retry duplicates the observation (it is an append). To later CORRECT or REMOVE a fact, edit the memory note by the `noteId` this returns with edit_note (findReplace its text — empty replacement to drop it). Use for things worth remembering across sessions — NOT transient task state, and NOT shared project knowledge (use create_note for that). You do not choose where it goes: the space, folder and kind are fixed.',
    annotations: {
      title: 'Remember about the user',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  remember_about_project: {
    description:
      'Record a durable fact about a PROJECT (decisions, conventions, gotchas, ongoing work) into the project\'s private agent-memory — symmetric to remember_about_user but about the project, not the user. `project` is a handle from get_my_projects — do not guess it. Appends as a readable observation under a memory `category` (a label like "decisions" — pick or reuse one; do NOT pass a path). Optional `summary` is a one-line digest — passing it OVERWRITES the existing one (the response\'s `summaryUpdated` says which); omit to keep it. The response reports `outcome` (`created`/`appended`/`skipped`). Pass `idempotencyKey` to make a retry safe — without one a retry duplicates the observation. To later CORRECT or REMOVE a fact, edit the memory note by the `noteId` this returns with edit_note (findReplace its text — empty replacement to drop it). This is your MEMORY about the project (notes-to-self), NOT shared knowledge for the user — for a user-visible knowledge note use create_note. You do not choose where it goes: the folder and kind are fixed.',
    annotations: {
      title: 'Remember about the project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  create_note: {
    description:
      'Create a NEW knowledge note in a project (shared, user-visible knowledge — NOT your private memory; for durable facts about the user use remember_about_user, about the project use remember_about_project). `project` is a handle from get_my_projects — do not guess it. Checks your write access. `body` is Markdown, and it TITLES the note: the leading `# H1` of `body` is the title — author it there. `title` is OPTIONAL — pass it to set the title explicitly (it then wins, and a duplicate leading `# title` in `body` is stripped, so do NOT write the title both as the field and as the body’s first heading); the response echoes the resolved `title`. Additive only: it never overwrites — if a note with that title already exists you get a clear error, so change an existing note with edit_note instead of recreating it. Optional `path` is the destination FOLDER (not a file): pass a folder relative to the project (e.g. `research/arch`), OR paste a folder `path` verbatim from list_notes (its space-relative form) — both work, the server will not double the project prefix. `type`/`tags` organise it; the path is normalised and may not escape the project. `links` materializes typed edges FROM this note in the same write — each `{relation, to}` (an existing note-id) or `{relation, toTitle}` (a forward-reference by title, even to a note not created yet). `createdAt` (ISO-8601) dates the note by when it actually happened (for imported/dated material, not the write instant); `fileName` sets the storage filename (sans `.md`) independently of the title. The response echoes where it landed (`path`, `space`), the `outcome` (`created`, or `skipped` on an idempotencyKey replay), an integrity stamp (`bodyBytes`/`bodyHash` of the `body` you sent — recompute to confirm your bytes arrived intact, no re-read), and `warnings` (e.g. `possible-secret` if the body looks like it holds a credential — advisory, never blocks). To create MANY notes at once use create_notes.',
    annotations: {
      title: 'Create project note',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  edit_note: {
    description:
      "Change an existing note incrementally — prefer this over rewriting a whole note with create_note. `ref` is a note-id (from search or get_note). Operations, all addressed by WORDS not line/character positions: `append`/`prepend` add `content` to the end/start (additive and safe); `replace` overwrites the WHOLE body (a full rewrite); `replaceSection` replaces the body under a heading (pass the heading text as `section` — get_note's `outline` lists the valid ones); `findReplace` swaps an exact, UNIQUE snippet (`find`) for `content` — copy the snippet verbatim from get_note and include enough context that it occurs once, and pass an EMPTY `content` to delete that snippet. Memory is just a note: to correct or REMOVE a single remembered fact, edit the memory note by its id the same way (findReplace its exact text, empty `content` to drop it; or `replace` the whole category). Pass the `versionToken` from get_note so a concurrent edit is not clobbered; on a conflict you get a clear error — re-read and retry. The response echoes where the note lives (`path`) and an integrity stamp (`bodyBytes`/`bodyHash` of the resulting body) so you can confirm a large edit landed intact without a re-read. Edits keep the note where it lives; they never change its kind.",
    annotations: {
      title: 'Edit a note',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  delete_note: {
    description:
      'Move a note to the trash — your one way to remove a whole note, and it is REVERSIBLE by construction: the deletion is recorded and the note goes to the space trash, where the USER can restore it. You cannot restore or permanently erase it (those are human actions) — so deleting is always safe to undo, which is exactly why you are allowed to do it. `ref` is a note-id (from search/list_notes/get_note) — search or list_notes FIRST to be sure you have the right one. Use it for a note created in error or a clear duplicate. Works on any note you can reach, including your own agent-memory (a deleted memory note appears in the trash flagged as memory). To remove only PART of a note — one fact, one section — do NOT delete the whole note: edit it with edit_note instead (findReplace with an empty replacement, or replaceSection).',
    annotations: {
      title: 'Delete a note',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  move_note: {
    description:
      'Move a note to a different folder, keeping its name. `ref` is a note-id (from search/list_notes/get_note); `toFolder` is the destination folder — pass a folder `path` exactly as list_notes reports it (do NOT build a path by hand), or an empty string for the space root. A folder that does not exist yet is created. The note keeps its id and its URL, and its inbound links keep working — only where it lives changes. The note stays in its own space. To change the TITLE instead, use rename_note; to change the body, use edit_note; to move a whole FOLDER, use move_folder. Safe to repeat: moving a note to where it already is does nothing.',
    annotations: {
      title: 'Move a note',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  rename_note: {
    description:
      'Rename a note — change its title (the display name, which also renames its file). `ref` is a note-id; `title` is the new title. The note keeps its id and its URL, and it is LINK-SAFE: the old title is remembered as an alias, so other notes that link to it by its old name keep resolving — nothing else is rewritten. You do NOT need a versionToken: the tool reads the note itself; if someone edited it at the same time you get a conflict error and just retry. Use move_note to change the folder, edit_note to change the body, delete_note to remove the whole note. (To rename a FOLDER use rename_folder; a PROJECT, rename_project.)',
    annotations: {
      title: 'Rename a note',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  move_folder: {
    description:
      "Move a whole FOLDER (and everything inside it) to a different parent, keeping its name. `folder` is the folder's `path` exactly as list_notes reports it (do NOT build a path by hand); `toFolder` is the destination parent folder (same — or an empty string for the space root; a parent that does not exist yet is created). `project` selects which space the folder is in (a handle from get_my_projects) — omit for your personal domain. Every note inside keeps its id and its URL, and inbound links keep resolving. The folder stays in its space. To change the folder's NAME instead, use rename_folder; to move a single note, use move_note. Safe to repeat: moving a folder to where it already is does nothing.",
    annotations: {
      title: 'Move a folder',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  rename_folder: {
    description:
      "Rename a FOLDER — change its name in place; everything inside moves with it. `folder` is the folder's `path` (from list_notes); `name` is the new name (just the name, NOT a path — use move_folder to change where the folder lives). `project` selects the space (omit for your personal domain). The notes inside keep their ids and URLs, and inbound links keep resolving. If this folder is a marked PROJECT, its files move but its handle does NOT change — use rename_project to change a project's handle. To rename a single note, use rename_note.",
    annotations: {
      title: 'Rename a folder',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  rename_project: {
    description:
      "Rename a PROJECT — change its handle and/or its human display name. `project` is its current handle (from get_my_projects). Pass `slug` to change the addressable handle (it becomes `space/<slug>`) and/or `displayName` for the human-facing name — at least one. It is LINK-SAFE: the OLD handle keeps resolving as an alias, so anything still using it works. This changes the project's IDENTITY only, NOT where its folder lives — to move or rename the underlying folder use move_folder / rename_folder. A ROOT project's handle is its space's name and cannot be changed here (renaming a space is a human action).",
    annotations: {
      title: 'Rename a project',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  link: {
    description:
      'Create a typed link from one note to another so they connect in the graph. `from` is a note-id (from search or get_note); the target is EITHER `to` (an existing note-id) OR `toTitle` (a forward-reference by title — link to a note you have NOT created yet; it resolves automatically once a note with that title exists, so a staged migration never loses an edge). `relation` is a short label for how they relate (e.g. "depends_on", "relates_to"). Both notes must end up in the SAME space — cross-space links are not supported yet. Idempotent: linking the same pair with the same relation again does nothing. To create MANY links at once use link_many.',
    annotations: {
      title: 'Link two notes',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  create_notes: {
    description:
      'Create SEVERAL knowledge notes in one project in a single call — the tool for migrating or importing many notes (dozens of create_note calls otherwise). `project` applies to every note; `notes` is an array, each item exactly like create_note (body — whose leading `# H1` titles the note; optional title/path/type/tags/links/createdAt/fileName/idempotencyKey) but WITHOUT its own project. Best-effort and NON-transactional: each note succeeds or fails independently — the response `results` array reports each by its `index` and `title` with either `ok:true` (plus the same echo create_note gives) or `ok:false` with an `error`, so you retry ONLY the failures. Inline `links` may forward-reference notes created later in the SAME batch (by `toTitle`). Search first to avoid duplicates; a per-note title collision fails just that item.',
    annotations: {
      title: 'Create many notes',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  link_many: {
    description:
      'Create SEVERAL typed links in a single call — edges are small and numerous, so this is the biggest round-trip saving when building a graph. `links` is an array of `{from, relation, to|toTitle}` items, each exactly like the single link tool (use `toTitle` for a forward-reference to a not-yet-created note). Best-effort: the `results` array reports each link by `index` with `ok:true`/`ok:false`+`error`, so you retry only the failures. Idempotent like link. Links sharing a `from` note are applied together efficiently.',
    annotations: {
      title: 'Link many notes',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const satisfies Record<string, ToolMeta>

/** The MCP `serverInfo` (returned in `initialize`). */
export const SERVER_INFO = { name: 'notarium', version: '0.9.0' } as const

/** The server `instructions` text (returned in `initialize`) — the main lever on
 *  call ordering; keep it a STATIC literal (no note content) and under ~200 words. */
export const SERVER_INSTRUCTIONS = [
  'Call `start_session` first. When it returns `session.id`, retain that id and pass it as the top-level `session` argument on every subsequent tool call. Notarium is your knowledge workspace; the bootstrap also loads your profile, projects, added roles, and what changed since you last looked.',
  'Search before you write: `search` finds existing notes — and now your own agent-memory too — so you do not create duplicates. To browse structure use `list_notes` (an `ls` of a folder) and `recent_activity` (the latest changes).',
  'Three kinds of writing: `remember_about_user` and `remember_about_project` record durable facts into private memory (about the user / about a project); `create_note` adds shared, user-visible knowledge to a project. The agent never picks where memory goes — its location is fixed. Migrating or importing many notes? Use `create_notes` and `link_many` (batch, best-effort per item) instead of one call each.',
  'Change a note with `edit_note`, addressed by words — a heading or an exact snippet, never line numbers; memory is just a note, corrected the same way. Reorganize, all `verb_entity`: a note with `move_note` (to another folder) / `rename_note` (its title); a whole folder with `move_folder` / `rename_folder` (by its `path` from list_notes); a project with `rename_project` (its handle/name) — renames are link-safe (old names keep resolving). Remove a whole note with `delete_note`: it is reversible — the note goes to the trash and the user can restore it. Connect notes with `link` — `toTitle` forward-references a note not created yet.',
  "Writes are scoped by your token — you can only reach spaces you are a member of, never another user's. Identifiers are note-ids, stable across rename and move. Pass the `versionToken` from a read back into an edit so concurrent changes are not clobbered.",
].join(' ')
