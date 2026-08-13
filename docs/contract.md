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

The surface splits into three route classes (#16):

- **Space-scoped** — under the `/api/s/<slug>/…` prefix (notes, tree, buckets, graph, search, status, events, note creation, folder moves). A request without a space physically has no route — fail-closed by construction.
- **Id-addressed global** — `/api/note*`, `/api/previews`, `/api/move`: the arbiter of which space a note lives in is the identity registry, not a query parameter.
- **Host-level** — `/api/spaces`, `/api/config`, `/api/health`, `/api/about`.

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

## Deliberate boundaries / caveats

- The package's public surface is the `index.ts` barrel; the domain split by layer (`consts/` · `schemas/` [`rest/` · `rest/agent/` · `tools/` · `primitives.ts`] · `libs/` · `registry.ts`) is internal — downstream imports from the barrel and never notices a refactor.
- `/api/*` paths as client-side string literals — extraction deferred (#56 backlog), non-breaking.

## Seams (files)

- `packages/contract/src/` — schemas + registry + zod-free consts.
- `packages/server/src/apps/server/routes/` — REST transport + `wire.ts`.
- `packages/web/src/services/api/` — client, typed by the contract.
