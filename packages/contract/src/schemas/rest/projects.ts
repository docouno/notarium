import { z } from 'zod'
import { ProjectStatusSchema, SpaceSlugSchema } from '../primitives'

// Mark a folder (or the space root, folderPath: '') as a project: server mints a
// stable id + per-space-unique slug and writes a `.notariummeta` marker.
// The marker is engine-managed and sits OFF the safeRelPath note routes — a
// dot-named sibling the note index never sees — so it never surfaces as a
// note. Idempotent: marking an already-marked folder returns its row and never
// duplicates the marker. Content can live outside projects, so creating a folder
// does NOT mark it; marking is this explicit act. Wire row carries the bare
// slug; the agent addresses by handle (`space/slug`).
// canon: docs/note-model.md#note-ontology
export const ProjectRowSchema = z.object({
  id: z.string(),
  handle: z.string(),
  slug: z.string(),
  /** Folder path within the space ('' = root, used by the human UI to find the
   *  root project). The agent-facing MCP ProjectSummary omits path on purpose
   *  (poka-yoke — the agent addresses by handle). */
  path: z.string(),
  displayName: z.string(),
  space: SpaceSlugSchema,
  status: ProjectStatusSchema,
  /** Past handle slugs the resolver still honours: renaming retires the old
   *  slug here so `space/<old-slug>` keeps resolving. Present on the human REST
   *  projection; the agent-facing MCP ProjectSummary omits it (resolution is
   *  server-side). Absent/[] = never renamed. */
  aliases: z.array(z.string()).optional(),
})

export const MarkProjectRequestSchema = z.object({
  /** Relative folder path within the space; '' marks the space root. */
  folderPath: z.string(),
  /** Bounded — it lands in the marker file + registry row, so an unbounded value
   *  is storage amplification. */
  displayName: z.string().min(1).max(200).optional(),
  /** Create a NEW empty project: mint the folder (the marker write
   *  mkdir's it) rather than marking an existing one. The folder must NOT
   *  already exist (409 if it does). Absent/false = mark an EXISTING folder
   *  (the folder must exist), the original behaviour. */
  create: z.boolean().optional(),
})

export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectRowSchema) })

// Rename a project: PATCH /api/s/<slug>/projects/<id>. The slug is not
// immutable — changing it retires the old slug into the project's alias history
// (marker + registry), so `space/<old-slug>` keeps resolving (id-first → current
// → alias). At least one field must be present. The ROOT project's handle IS the
// space slug, so its slug is not renameable here → 400. A slug already held by
// another project in the space → 409: an explicit rename is predictable, never
// silently suffixed (unlike the mint path). displayName is the human label;
// status/archive stay a separate lifecycle phase.
// canon: docs/note-model.md#note-ontology
export const PatchProjectRequestSchema = z
  .object({
    /** New handle slug. Server-slugified, so a human-typed value is
     *  normalised; it must be unique in the space (409 otherwise). */
    slug: z.string().min(1).max(200).optional(),
    /** New human label, bounded. */
    displayName: z.string().min(1).max(200).optional(),
  })
  .refine((b) => b.slug !== undefined || b.displayName !== undefined, {
    message: 'nothing to update (slug or displayName required)',
  })

export type ProjectRow = z.infer<typeof ProjectRowSchema>

export type MarkProjectRequest = z.infer<typeof MarkProjectRequestSchema>

export type PatchProjectRequest = z.infer<typeof PatchProjectRequestSchema>

export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>
