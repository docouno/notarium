# Exporting the database to ZIP (#17)

Download an entire space as a single archive of source files, preserving the folder structure. The user's files are the source of truth (P1), so the export reads them directly from disk (through the engine's storage seam) rather than reassembling them from the index or MCP tools: the archive carries the real files, including the `notarium-id` in Markdown frontmatter and binary resources in package mounts, and is therefore round-trippable — it can be restored/migrated without loss.

## Data path

The `KnowledgeStore` port carries an optional `exportNotes(opts?): AsyncIterable<ExportEntry>` capability — a stream of `{path, content}`, one per file. AsyncIterable rather than an array is deliberate: the host zips and streams element by element, so an arbitrarily large database is never held in memory and never blocks.

`NotariumStore` traverses its mounts directly. Note-only mounts use `scan()` + `read()`; package/resource mounts may expose `exportFiles()` to stream every regular file as raw bytes without changing the Markdown-only knowledge index. Entries from a skill mount carry a preservation bit, so package bytes bypass note-oriented presentation transforms even when an embedded host configures a non-default mount prefix. `scope` reuses the visibility axis (#78): the default `user` keeps only user-visible classes — the dot-namespaced agent-memory and skill mounts drop out, and "download my notes" does not scoop up private agent state; `all` is a full **space export** (all mounts, with paths carrying the mount prefix), including complete installed Agent Skills packages under `.notarium/skills` by default. It is not a disaster backup of accounts, grants, history or jobs. The bare engine does not enforce visibility for list/search/graph (the read-model does that), but export is a deliberate bulk read that bypasses the read-model snapshot, so it applies scope itself. For export, `CachedStore` is a pure passthrough to the engine (the source-of-truth files are read, not a derived snapshot); the method is assigned only when the engine carries it, so `store.exportNotes` is falsy exactly when the engine cannot do it — the signal on which the host returns a 404.

Adapter-owned recovery state is never an authored space resource. In particular,
LocalFS excludes `.notarium-fs-ops/` from `exportFiles()` even for `scope=all`;
the system disaster backup preserves that namespace together with causal metadata
instead (see [backup.md](backup.md)).

Revision blobs are also outside the user-export contract. History `contentMode:source`
is an inspection surface for one retained opaque state, not a download/export channel;
an export carries current authored files only. Importing that ZIP therefore creates or
updates current notes through normal writes—it does not replay historical ids, receipts,
restore operations or journal order.

`InMemoryStore` (the engine of the e2e fake) has no files and reconstructs the file from the snapshot (frontmatter `notarium-id`/`title`/`tags`/`summary` + `# title` + body) — this mirrors the FORM that the real engine returns, not byte-for-byte identity: the fake is a specification of behavior, and the contract holds (one entry per note, `path` = `filePath`, `content` a parseable file).

The parameters are shared across both paths: `frontmatter=keep|strip` (`keep`, the default, ships each file as is; `strip` cuts the YAML block from ordinary note `.md` entries only — a clean copy for reading, lossy, losing the `notarium-id` and the tags; every member of a skill package, including `SKILL.md` and Markdown resources, remains byte-identical so the package stays valid; non-Markdown bytes are never decoded or transformed), `scope=user|all` (`user`, the default — only the user's notes; `all` adds hidden agent-memory and complete skill-package mounts), `folder=<path>` (narrow down to a subtree; the path is untrusted and is normalized by `safeRelPath`).

## Async export via the jobs layer (#105)

When the host carries a meta-DB (the norm for self-host), export is **asynchronous** by default: on very large databases the synchronous stream (see below) ties up the request/worker for minutes, with no progress and no resumable download, and a dropped connection means downloading again from scratch. The async path removes this: `POST /api/s/:space/export` enqueues a `kind: export` job in the [jobs layer](jobs.md), a background worker assembles the ZIP into the artifact storage through the same `exportNotes` seam (no rework), and the client sees progress and downloads the finished file with resume support. Close the tab, lose the connection, survive a server restart — the job lives on.

The endpoints (all `space:read`; a job belongs to its space and to the principal that enqueued it; someone else's or a nonexistent one → 404, as everywhere): `POST …/export` (enqueue; body = the same `scope`/`frontmatter`/`folder`; response 202 + the job status), `GET …/jobs` (the principal's most recent exports), `GET …/jobs/:id` (status polling), `POST …/jobs/:id/cancel` (cooperative cancellation), `GET …/jobs/:id/download` (serving the artifact with `Accept-Ranges`/`206 Partial Content`/`If-Range`+`ETag` — resuming an interrupted download). Progress travels over two channels: a named SSE `job` event on the existing per-space bus (live, addressed only to the principal that owns the job — status/error/artifact do not leak to other members of the space, as in REST) and polling of the status endpoint (a reliable fallback) — whichever updates first.

The Export tab UI follows a single async path: the button enqueues a job → a progress bar (% by note count, when known) with "Cancel" → on completion an automatic download + "Download again"/"Export again". Leaving the tab and returning is safe: on mount the hook re-picks-up the principal's most recent job (`GET …/jobs`) — a running one it keeps tracking with progress, a finished one it shows with a download button (no auto re-download on return). Exporting a **folder** is available from the tree's context menu ("Export folder") — the same async job with a `folder` parameter, progress via a sticky toast with "Cancel" (cooperative cancellation), sharing the tab's lifecycle poller (canceled on space switch/unmount). The download of the finished artifact itself is anchor navigation (a cookie-authenticated GET): the browser streams the file straight to disk, taking the name from `Content-Disposition`, and a large database never settles into the tab's memory.

**Degradation.** On a host without a meta-DB (none-mode) there is no jobs layer: enqueue returns 404, and the client honestly falls back to the synchronous streaming path below. This is not two parallel paths for one tier, but degradation by capability.

## Synchronous streaming path (#17, fallback)

The `GET /api/s/:space/export` handler (authz `space:read`) is an `application/zip` stream, `Content-Disposition: attachment; filename="<space>-notes-<date>.zip"`. The response is hijacked onto the raw socket (like the MCP transport) and does not cross the contract-validation boundary — it is a binary stream, not JSON. A dropped connection stops both the archive and the engine traversal (the async generator stops being pulled) — a canceled download does not keep the server reading the whole database; socket backpressure throttles the traversal so that a slow download does not buffer the database in the archive queue. It remains as a capability fallback for when async is unavailable (none-mode / no meta-DB).

## Deliberate boundaries

- User attachments (the future `attachment` class) are not mounted/exported yet. The export entry already carries bytes: installed skill resources use that channel today, and a future attachment mount can adopt it without a contract change.
- Export is one space at a time: spaces are isolated stores with their own authz. "Download everything at once" across all spaces is a future trivial fan-out over `exportUrl` per space (deliberately deferred out of #105).
- The async-enqueue parameters (`POST …/export`) are validated by zod (`ExportEnqueueRequest`); for the synchronous handler the parameters in the query bypass the JSON boundary (the response is binary) — they are parsed inline by a strict mapping (an unknown `scope` → `user`, an unknown `frontmatter` → `keep`).
- The async-export artifact lives by a TTL (7 days by default) and is deleted by the jobs-layer GC; re-download works until the artifact expires (see [jobs.md](jobs.md)).
- The `notarium-id` is exported as is in the file; an id that lives only in the meta-DB and has not yet been written into the frontmatter is not injected (the production engine writes the id into the frontmatter on every save, so in practice it is present).
