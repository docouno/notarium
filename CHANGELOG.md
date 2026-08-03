# Changelog

All notable changes to Notarium are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/). One version number covers the whole repository — the image, the npm CLI and every workspace move in lockstep, so `notarium@X.Y.Z` and the `X.Y.Z` image are always the same revision and there is no compatibility matrix to guess at.

## [Unreleased]

### Fixed

- **A misspelt `META_DB_URL` no longer opens an empty database.** Every tool now classifies the URL the same way, in one place: `postgres://…`/`postgresql://…` (scheme case-insensitive), `sqlite:<path>`, `sqlite::memory:`, or a plain file path. Anything else — `postgress://…`, `mysql://…`, a bare `sqlite:`, or a connection string that lost its scheme and carries a credential (`host=db password=…`, `//user:pw@host/db`) — is refused with a message instead of being read as a filename, which previously started the server on a fresh empty database (re-opening the public first-run screen while the real data sat untouched) and made `admin` report "no users". A path that merely looks Postgres-shaped, such as `postgres-backup/meta.db`, stays a path.
- **The recovery CLI no longer creates the database it was pointed at.** `admin` refuses a `META_DB_URL` whose file is missing, empty or not a file at all — a bare `touch meta.db` used to pass — and refuses `sqlite::memory:`, rather than answering from a database it just made. (A Postgres `META_DB_URL` is still bootstrapped on connect, as the server does.)

### Changed

- **`AUTH_MODE=password` refuses to start on an in-memory meta-DB.** Such a host forgets every account on restart and re-opens first-run setup to whoever loads it first; use a file or Postgres, or opt out with `AUTH_MODE=none`.

### Security

- **A Postgres password is no longer printed where Notarium reports which database it is using** (the `admin` banner, the seeder, boot errors). A SQLite path is still named in full — that is the one you need when recovery opens the wrong file — while a `postgres://…` URL is named by its scheme alone, and a value that carries a credential where a path belongs is refused before anything prints it. Previously the whole URL was printed verbatim; rotate the credential if such a line reached a shared log. Your driver still names host, database and user in its own connection error.

## [0.1.0] — 2026-08-02

The first public release. Notarium is a self-hosted knowledge base on plain Markdown, equally open to a person (web editor, REST) and to an AI agent (a built-in MCP endpoint): an agent's edits are versioned, bound by the same permissions, and signed with who made them, exactly like edits from the interface. Free and open source under [AGPL-3.0-only](LICENSE), with a separate [commercial license](COMMERCIAL-LICENSE.md) for productizing Notarium itself.

Development ran from June 2026 to this release, and nothing shipped before it — no earlier releases, no published images. So this entry describes the product rather than a delta against something you could have been running; every later entry is an ordinary delta.

### Added — Notes, the editor, and reading

- **Markdown files are the source of truth.** One `.md` per note in real folders, with a `notarium-id` in the frontmatter as its identity. The search index, the graph and the rest of the derived data are rebuilt from the files; the metadata that cannot be derived from them — revision history, users, access grants — lives in a separate database.
- **A tree built for scale**: virtualized and lazily loaded for tens of thousands of notes, real folders including empty ones, and drag-and-drop of notes and whole folders. Renaming or re-foldering a note moves the file instead of leaving a copy behind.
- **A CodeMirror 6 editor** with a formatting toolbar, multi-cursor and hotkeys, and a reading mode with GitHub-flavored Markdown, Mermaid diagrams and KaTeX math.
- **`[[Wikilinks]]` that resolve by title**, including "ghost" links that offer to create the note they point at. A rename does not break them: the old title goes into alias history, so linking notes are never rewritten.
- **Reading typography**: 15 self-hosted font presets across sans/serif/mono with Latin, Cyrillic, Greek and Vietnamese subsets, and four text sizes, applied consistently across reading mode, the editor, previews and history.
- **Global hotkeys over an action registry**, with presets (Notarium / VS Code / Obsidian / Vim / JetBrains), per-action rebinding, and a `?` cheatsheet read from the active map.
- **An installable app shell** — a PWA with a static precache and a prompt-to-update flow, where data always comes from the network — plus a settings section whose preferences follow you across devices.

### Added — Finding things

- **Full-text search always on** (SQLite FTS5, bm25), with optional **semantic search** (`sqlite-vec` embeddings) fused into it through weighted RRF, plus an optional one-hop graph channel and heading-aware chunking. Two embedding tiers ship in the same image — a compact model for small hosts, and bge-m3.
- **Honest degradation, not a query flag.** If the vector channel is off or its native dependencies fail to load, search silently becomes lexical-only and the response shape is identical. The published image ships semantics **off**: a homelab pull must not silently commit ~600 MB of RAM and background CPU on first boot, and `-e VECTOR_SEARCH=on` enables it with no rebuild.
- **Indexing that stays out of the way.** Embedding runs in a worker-thread pool off the event loop and the background backfill yields to interactive requests; under a full backfill on 8 cores the event loop stays at p95 3.7 ms. A live indexing indicator answers "is it hung, or is it indexing?" in the UI instead of leaving you to guess.
- **A Spotlight command palette**, a document feed with grouping, sorting and facets, favorites, tags, and a dashboard with an activity heatmap.
- **A knowledge graph** with server-side clustering and layout, colour by folder or cluster, size by links, focus search, and ghost→create. Every open note carries a side panel with its local graph, inbound and outbound links, metadata and history.

### Added — History and identity

- **Identity survives everything.** A note's internal id is stable across rename, move, and even an engine swap; `/n/<id>` addresses it and the slug is decorative.
- **A revision journal** with a full snapshot per revision, stored as content-addressed blobs, a word-level diff, and restore. Every revision records its author — a human, a specific agent, or an external file editor.
- **Optimistic concurrency on every write.** A stale version token returns `409` instead of overwriting, so two tabs — or a tab and an agent — cannot silently lose each other's work. Restore goes through the same path.
- **A trash with restore**, and deletion recorded in the journal like any other change.
- **External edits are reconciled even when they hide.** Editing a note outside Notarium is a supported path, including the awkward case of a rewrite that preserves both size and mtime (a timestamp-preserving sync, a scripted edit), which naive change detection misses entirely. Reconciliation carries a cheap adapter-opaque change token and, as a backstop for missed or pathless watcher events, a bounded rotating integrity sweep over the raw files, with a raw-file SHA-256 as the final arbiter. Fingerprints are bound to the exact indexed sequence, so a crash mid-update fails safe rather than leaving search and the graph quietly stale.
- **Mutations of one note are serialized**, and every file write lands through an exclusive per-operation temp file. Concurrent save/move/remove cannot leave two paths holding different bodies under one id, resurrect a deleted note, or swap bodies between notes written in parallel.

### Added — Spaces, access, and projects

- **Spaces** are the isolation boundary: each has its own index, graph, search, tree, history and membership, served by exactly one engine instance.
- **Multi-user from the start.** A first-run setup screen mints the owner through a race-safe claim; users, sessions, tokens and space membership live in the metadata database, with owner / writer / reader roles, one-time invite and reset links, and a recovery admin CLI for a locked-out instance. `AUTH_MODE=none` is available as an explicit single-principal mode for desktop and development.
- **A personal space per user** — guaranteed at every account-issuing point and undeletable, so there is no host-global "default space" to configure.
- **Projects** are marked folders inside a space, addressed by a stable handle rather than a path. The mark is a dot-file carrying an id, so a project survives being moved from outside Notarium.
- **A note's class is enforced, not filtered.** It is derived from where the note is mounted and checked at a single checkpoint in the read model — which is how an agent's own memory stays indexed and recallable while staying out of user-facing search, feed, tree and graph. Visibility gates discovery, not direct access.

### Added — Agents (the MCP gateway)

- **A built-in semantic MCP gateway at `POST /mcp`** — the official `@modelcontextprotocol/sdk`, streamable-HTTP, stateless, on the same process and port as REST. **21 intent-oriented tools** across bootstrap, discovery, read and recall, writing, reorganization, and batch operations — a narrow intent surface instead of generic CRUD over the storage engine.
- **Token scope is the agent's ceiling.** A read-only token does not even see the writing tools in `tools/list` — they are absent, not refusing — and a token's grants define which spaces exist for it. Another space is unreachable by construction.
- **An OAuth 2.1 facade** for connectors that cannot take a pasted token (claude.ai, chatgpt.com): discovery per RFC 9728/8414, a server-rendered consent screen with space narrowing, PKCE. A connector token maps to the same principal and is never granted `manage`, so a leaked one cannot issue another.
- **Security by construction.** The trifecta "private data × untrusted content × outbound channel" is broken by design: no tool has an outbound channel, there is no cross-space linking, and the agent's only destructive tool moves a note to the trash — restore and purge are human actions, so nothing an agent does is irreversible. Writes go through the version check and carry the principal into the journal. Untrusted note content is defanged on output and never mixed into tool descriptions or server instructions. Denials use 404 semantics, so a 404 is not proof of absence.
- **Agent memory as ordinary notes.** Durable facts about the user and about a project are recorded through dedicated tools into a hidden mount, and corrected with the same word-based editing as any other note. Search covers it, so "search before you write" dedupes memory too.
- **Context curation.** What an agent receives on its first call is configurable: always-load pins, reusable context sets, and muting for noisy memory categories, all under a shared token budget.

### Added — Import, export, and backup

- **Import from Claude and ChatGPT conversations, from MCP memory, and from Markdown**, through the ordinary write path. Streaming and bounded in memory at any size, with dates carried as data so history lays out by real days, and deterministic source-keyed names so a re-import overwrites instead of duplicating.
- **Space and folder export to ZIP**, streamed and read from disk directly, so the result round-trips.
- **Verified online backup and fresh-root restore.** `backup` streams a consistent archive without stopping the service, protected by a SHA-256 manifest; `backup verify` validates an archive without touching live data; `restore` installs it into a fresh root and refuses unsafe paths, unmanifested payloads and failed integrity checks.

### Added — Distribution and operations

- **One self-contained image.** A single Node process serves the web interface, the REST API, the MCP endpoint and the in-process engine — no external database, queue or search service. The entrypoint is the built-in `notarium` CLI: `start`, `backup`, `restore`, `admin`, `healthcheck` and `version` are its public surface.
- **One data root.** The metadata database, engine indexes, job artifacts and the notes themselves all derive from `DATA_DIR` (`/data` in the image). Nothing about data layout is a required setting, so nothing about it can be half-configured.
- **A REST API, not a private backend.** `/api/*` is a first-class surface over the same core the web interface uses, validated at the boundary against an executable contract — zod schemas that server and client both derive their types from, rather than a hand-maintained document. Live updates arrive over SSE; writes are optimistic, so a stale token gets a `409` instead of clobbering someone.
- **A traceable release.** The image is built from an exported release tag rather than a working directory, carries its version, commit, build time and a link to that exact revision in `/api/about`, `notarium version` and OCI labels, and is verified against that record before it is pushed. Version tags are immutable, and `latest` only moves after the version tag is published.
- **Complete third-party notices.** Every bundled dependency and vendored font ships with its license and copyright, and a release gate refuses to publish an image whose notice corpus does not match what it actually contains.
- **An About section** — Settings → About and `GET /api/about` report the running build identity, the live search mode, and, for administrators, the deployment shape.
- **The `notarium` npm package** — `npx notarium` prints how to run the workspace as a container and reports its own version. Operating a running instance stays with the CLI inside the image, which is a different surface under the same name.

### Known limitations

- **The published image is `linux/amd64`.** Other architectures build from source; a multi-arch artifact is a separate piece of work.
- **Single-tenant self-host.** Deployment is designed for one instance — the login rate limit and the live-update socket registry live in process memory. Pooled multi-tenant hosting with open registration needs a second isolation boundary that is not built, and is deliberately out of this release.
- **Semantic search is off by default in the image** — a deliberate resource choice, not a missing feature. See above.
- **`notarium@0.1.0` on npm predates this release.** The name was claimed on npm before the CLI had been reviewed, and npm versions are immutable, so what sits there under `0.1.0` is an earlier, weaker build than this repository describes. The corrected CLI reaches npm at the next product version; until then, prefer the CLI inside the image.
