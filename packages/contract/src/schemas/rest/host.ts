import { z } from 'zod'
import { META_DB, SEARCH_MODE } from '../../consts/spaces'
import { enumValues } from '../../libs/enumValues'
import { IsoTimestampSchema, SpaceSlugSchema } from '../primitives'
import { AuthModeSchema } from './auth'

/** The meta-DB backing this host (admin diagnostics): 'sqlite'/'postgres' name
 *  the wired store, 'none' a bare engine with no meta-DB. */
export const MetaDbSchema = z.enum(enumValues(META_DB))

/** Host capability declaration — a deployment fact the wiring asserts,
 *  never a runtime probe. Deliberately tiny: no engine internals leak, and there is
 *  no host-global default space — a principal lands in its own personal space
 *  (`me.personalSpace`), falling back to the first of `/api/spaces`.
 *  canon: docs/contract.md#routing */
export const ConfigSchema = z.object({
  capabilities: z.object({
    /** Can this host mint spaces at runtime? True only where the engine owns
     *  namespaces; an operator-static host leaves it false so the create UI
     *  hides honestly. */
    spaceCreate: z.boolean(),
  }),
})

/** Host About / diagnostics. Base (build identity + search capability) is
 *  visible to any signed-in principal; the `admin` block is non-null only for a host
 *  admin. Tier split is a leak guard: runtime and the embedder model ride admin,
 *  NEVER the base — a reader on a shared host must not fingerprint the runtime. Distinct
 *  from `/api/health` (liveness) and `/api/config`.
 *  canon: docs/contract.md#routing */
export const HostAboutResponseSchema = z.object({
  /** Build identity of the running server. `commit`/`builtAt`/`source` are null in an
   *  unbundled dev run — never fabricated (P5). The SPA carries its OWN build id as a
   *  bundle constant; comparing it to this catches a stale cached bundle vs a newer server.
   *  canon: docs/architecture.md#p5 */
  build: z.object({
    /** Lockstep across all packages (root package.json). */
    version: z.string(),
    commit: z.string().nullable(),
    builtAt: IsoTimestampSchema,
    /** Where THIS build's source lives, pinned to the exact revision — the running
     *  instance's own path back to its Corresponding Source. Only a released image
     *  carries it; a local build has no published source to point at.
     *  canon: docs/release.md#identity */
    source: z.string().url().nullable(),
  }),
  /** Search capability (user-facing — it shapes the result quality the UI explains).
   *  Reflects what ACTUALLY runs, not what was configured: a host whose vector
   *  deps fail to load degrades to `fts` honestly.
   *  canon: docs/architecture.md#p5 */
  search: z.object({
    mode: z.enum(enumValues(SEARCH_MODE)),
    vector: z.boolean(),
    /** The 1-hop wikilink RRF channel — ships off. */
    graphBoost: z.boolean(),
  }),
  /** Operational internals — non-null only for a host admin (leak cut). */
  admin: z
    .object({
      runtime: z.object({ node: z.string(), platform: z.string(), arch: z.string() }),
      /** The wired embedder, or null on an FTS-only host. */
      embedder: z.object({ id: z.string(), dimensions: z.number() }).nullable(),
      authMode: AuthModeSchema,
      spaceCreate: z.boolean(),
      metaDb: MetaDbSchema,
      uptimeSeconds: z.number(),
      // `engine` is a placeholder enum — one value today (Notarium is the sole impl).
      // canon: docs/architecture.md#p8
      spaces: z.array(z.object({ slug: SpaceSlugSchema, engine: z.enum(['notarium']) })),
    })
    .nullable(),
})

export type Config = z.infer<typeof ConfigSchema>

export type HostAboutResponse = z.infer<typeof HostAboutResponseSchema>
