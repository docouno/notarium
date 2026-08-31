# Notarium wire-surface contract

> Canon for the [`@notarium/contract`](../packages/contract/src) package: the executable contract of two wires — the SPA's REST surface (`/api/*`) and the agents' MCP tool surface (#21). Architectural frame — [manifest P4/P8/P9](architecture.md#p4). Class/visibility model — [note-model.md](note-model.md#note-classes).

The home of the contract's canon prose. Code in `packages/contract/src/*` links here via `// canon: docs/contract.md#<anchor>` instead of re-describing these invariants in comments (see the [comment protocol](architecture.md#comments)).

## Why the contract exists <a id="why"></a>

The front and back evolve independently; the one thing that must not shift under them is the wire between them (#18). The contract pins that wire with zod schemas, and so it is single:

- the spec the unit layer (#18.2) and the e2e fake validate against — one source of truth, not two diverging copies;
- the artifact the backend imports to validate its own responses (the same e2e spec stays green on any engine);
- typed: `z.infer<typeof XSchema>` gives the front request/response types for free.

Every schema keeps its `z.infer` type **next to it**, not in a separate trailing appendix.

## Wire v2: engine-agnostic <a id="wire-v2"></a>

The wire speaks the domain's language; engines map their dialects at their own edge (#54). Invariants:

- **identity is the internal note-id** ([P7](architecture.md#p7)); the permalink is retired, the sole storage-view field is `filePath` (the Files surface, never a note reference);
- **camelCase keys** — dialects (project-prefixed permalink, snake_case) stay in `engine-*`;
- **`space`** is an internal boundary (#16), never exposed on the wire; `project` on the wire is an addressable handle entity `(space, slug)` (see the [ontology](note-model.md#note-ontology));
- **timestamps are full ISO-8601 UTC** (`toISOString` form); `null` = the engine honestly doesn't know ([P5 degradation](architecture.md#p5)), never a fabricated or truncated date.

## Route families <a id="routing"></a>

View endpoint behavior and window semantics are specified in [views.md](views.md#execution).

The surface splits into three route classes (#16):

- **Space-scoped** — under the `/api/s/<slug>/…` prefix (notes, tree, buckets, graph, search, status, events, note creation, folder moves). A request without a space physically has no route — fail-closed by construction. List/tree/search rows may carry the dedicated discovery-only `viewType`; it is independent of both `noteType` and the capped custom-field blob. A Feed list projection may additionally carry only requested `card:true` field values and, when `viewSummary=1`, a bounded primary-view summary; detail-only state and unreadable/truncation bookkeeping never ride this window. Draft view preview uses `POST /api/s/:space/view-query` with a closed `{kind:'draft', directory}` context; the server resolves the containing project and the operation is read-only. Its first response returns source/schema generations; later column windows echo them so a prepared plan can be reused or a changed snapshot can conflict.
- **Id-addressed global** — `/api/note*`, `/api/previews`, `/api/move`: the arbiter of which space a note lives in is the identity registry, not a query parameter. `GET /api/note/views?id=` returns the saved carrier manifest/group skeleton, per-view source/schema generations, authoritative mutation capabilities and an opaque version-bound `viewRef`; `POST /api/note/view-window` accepts that ref, the returned generations, an opaque group key and a window ≤100. An evicted plan may be recomputed, but a generation mismatch is 409 rather than a mixed board. `POST /api/note/board-move` accepts the ref, card id, destination value/absence and optional neighbor ids; it derives the field/rank server-side and returns the explicit two-document outcome described in [views](views.md#board-move). A stale ref conflicts rather than retargeting by name. The ordinary `POST /api/note` update may carry an authored-field patch inside the same document CAS. `PUT /api/note/fields` is the atomic custom-field point-intent used by Meta, boards and agents; it resolves the space from the note id, not from client input, and returns the fresh note token. Future system metadata may share the resource path through explicit typed members, never by bypassing protected keys inside the generic `fields` map.
- **Host-level** — `/api/spaces`, `/api/config`, `/api/health`, `/api/about`.
- **Provider management** — `/api/providers/resources*` and
  `/api/providers/credentials*` are host-addressed but session-only (`self:manage`).
  The ownership, network and recovery guarantees behind these wires live in
  [providers.md](providers.md).
  Inventory and id-addressed reads are owner-only; a foreign id and a missing id have
  the same 404 response. Secret and resource-header values are write-only. Credential
  detail exposes only its non-secret configuration and typed resource references;
  narrowed PAT/OAuth tokens cannot discover either inventory.
  A resource create sends the complete header map. A resource PATCH instead sends
  header operations: a string sets/replaces one value, `null` deletes that name,
  and a name absent from the map keeps its existing ciphertext. This distinction is
  load-bearing: the client sees names only and cannot honestly reconstruct a full map.
  `POST /api/providers/resources/:id/validate` is the one route that makes a real
  outbound call. It is owner-only for the same reason — the call spends the owner's
  credential — and it is declared `self:manage` rather than checked: `manage` is
  above any token's ceiling, so the route is session-only by construction. Its
  outcome is per PURPOSE, not per resource: one address can serve chat and refuse
  embeddings. The outcome is stored only if the resource and credential runtime
  epochs it was taken under are both unchanged, and it is projected on READ by two
  independent rules: the provider's own sentence reaches the owner and a host admin
  only — it is prose about the OWNER's account, not about the address — and on a
  private address the outcomes derived from what the address answered additionally
  collapse into a plain works/does-not-work, because telling them apart is an oracle
  on internal state.
  `GET /api/providers/effective` is the other half of the family and the only one
  that answers about someone else's records: what this principal may actually call —
  what they own, plus what the Spaces they belong to were given — with a named
  `unusableBecause` beside everything they may not. It is session-only for a sharper
  reason than the rest: a narrowed token learns THAT the host has a model from the
  MCP `whoami`, never the names, owners and addresses behind it. A resource row is
  projected by AUDIENCE — the owner and a host admin get the addressee, its header
  names, its vendor, its private-network opt-in and its timeouts; anyone else gets
  what the resource serves, who pays for it, and `addressIsPrivate` — the DERIVED
  fact of whether the call leaves the host, never the opt-in, which is legal on a
  public origin and would read as "inside our network". The withheld fields are
  ABSENT rather than nulled. An offer nobody has accepted yet is not a row here at
  all: consent is the one place it is disclosed.
  Provider consent has one space-scoped inventory,
  `GET /api/s/:space/providers/attachments`, and three id-addressed mutations:
  `POST /api/providers/attachments` offers an owned resource to a Space or project,
  `POST /api/providers/attachments/:id/accept` conditionally accepts the epochs the
  manager was shown, and `DELETE /api/providers/attachments/:id` detaches it. Each
  attachment view carries those current epochs separately as `currentEpochs`; the
  epochs on the attachment row remain the previously accepted pair (or null for a
  pending offer). An epoch conflict returns a fresh view for one review-and-retry. The
  list is `space:manage`; accept/detach use host authentication plus the same check
  in-handler because their path contains no Space. `POST
  /api/providers/credentials/:id/retarget` changes one credential origin and every
  referencing resource address atomically; its request names the complete current
  reference set, so different path components are never guessed. Conflict responses
  carry the current disclosure diff or the per-resource exit (`detach` versus
  `fix-or-delete`), while foreign and vanished ids stay one 404.

## Operation registry <a id="registry"></a>

`export const contract` is a flat `as const` map of every operation, keyed by the `api.js` method name: `{ method: { request, response, conflict/event } }`. The fake backend (#18.2) and the tests resolve a schema by operation name through it. This is **not** ts-rest — a hand-rolled registry with no runtime router. The registry is the **only aggregator**: it imports req/resp from the domain modules and stays one source of truth; the domain files never duplicate the operation list.

## Zod-free wire modules <a id="wire-consts"></a>

`events.ts` / `http.ts` / `queryKeys.ts` / `time.ts` are deliberately **zod-free**, browser-safe consts (the SPA never pulls zod into its bundle). Their home is `consts/` (transport dictionaries are the same nature as domain dictionaries). The dependency is strictly one-way, schema → const: `StoreEventSchema` DERIVES its discriminants from `STORE_EVENT`, and the match of query keys against query-schema fields is checked by the type-guard `schemas/queryKeysGuard.ts` (not a `satisfies` in the const itself). Cross-wire literals are centralized here per the [placement convention](architecture.md#literals).

## Mappers at the boundaries <a id="mappers"></a>

Mappers are thin shape-guards, not business logic: the transport `apps/server routes/wire.ts` picks exactly the contract's fields (internals never leak "by accident"); the client's view-mappers live in `web/libs/*` (view types are structurally independent of the zod inference). A substantive divergence of shapes is a contract review, not a mapper's job.

## Optimistic concurrency <a id="cas"></a>

Writes are compare-and-swap (#50): `versionToken` (from a read) proves the complete byte-safe document state the caller saw—authored source, role/path-fallback semantics and provenance shape, excluding receipt lineage and proven runtime owner values. A concurrent metadata-only edit conflicts exactly like a body edit; current exact tokens are `v3:` fingerprints. Absent = "create / blind-append", and a stale token on overwrite → 409 with guidance ([P3](architecture.md#p3): never lose data silently). `idempotencyKey` returns a prior attempt's result instead of a duplicate; absent = no explicit dedup, and a keyless create whose destination is taken is REFUSED with its own 409 (`reason: note_already_exists`, carrying the occupant) rather than collapsing onto it—the path-upsert that used to swallow such a retry also swallowed genuine collisions, so it is gone ([note-model.md](note-model.md#create-collisions)). A retry after a lost response therefore reports "that note is already there" instead of overwriting it. A batch carries a per-item key; operations idempotent by construction (re-link) take neither.

## Filter language (inclusion) <a id="filters"></a>

One inclusion language across every selection facet (folders #93, tags #109, class, search): nothing selected = everything; each value **adds** (widens the result). Within a facet it is OR (union), across facets AND (folder ∧ tag ∧ q). Multiple values arrive as a repeated query key (`folders=a&folders=b`) — one key parses to a string, many to an array (preprocess normalizes both). Tags match case-insensitively and hierarchically (`ml` catches `ml/nlp`). The filter is applied **BEFORE** the offset/limit slice, so `total` is the honest population (the scrollbar / "jump anywhere"). Set caps are a DoS/URL guard, not a product limit.

Field filters compile into the persisted closed `FieldFilterAstV1`: top-level field clauses are
AND, conditions of one key are OR, and the only condition kinds are exact equality/list
containment, authored day, presence and unreadable. Feed query params and MCP repeatable args are
adapters into that same AST. Saved views store the AST directly. `note.view` equality/presence is
the one dedicated-marker branch; other projected/storage keys remain rejected. Broad recursive
query syntax, text grammar and non-field facets are not part of this v1 node shape.

## Deliberate boundaries / caveats

- The package's public surface is the `index.ts` barrel; the domain split by layer (`consts/` · `schemas/` [`rest/` · `rest/agent/` · `tools/` · `primitives.ts`] · `libs/` · `registry.ts`) is internal — downstream imports from the barrel and never notices a refactor.
- `/api/*` paths as client-side string literals — extraction deferred (#56 backlog), non-breaking.

## Seams (files)

- `packages/contract/src/` — schemas + registry + zod-free consts.
- `packages/server/src/apps/server/routes/` — REST transport + `wire.ts`.
- `packages/contract/src/schemas/rest/providers.ts`, `providerAttachments.ts` and
  `credentials.ts` — provider
  resource/credential shapes; `consts/providers.ts` is their zod-free vocabulary. It
  also holds the vocabulary of the provider call itself — delivery state, failure
  classes, journal outcomes and usage counters — because the meta-DB persists those
  words and may not reach into the runtime that produces them.
- `packages/web/src/services/api/` — client, typed by the contract.
