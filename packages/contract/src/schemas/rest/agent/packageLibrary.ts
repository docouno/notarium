import { z } from 'zod'

import { AGENT_PACKAGE_LIBRARY_QUERY_MAX } from '../../../consts'
import { DurableNonEmptyScalarSchema } from '../../primitives'
import { ProjectHandleSchema, ProjectSummarySchema } from '../../tools/primitives'

export const AgentPackageLibraryQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(AGENT_PACKAGE_LIBRARY_QUERY_MAX).optional(),
    source: z.enum(['system', 'catalog', 'owned']).optional(),
    home: z.enum(['personal', 'space']).optional(),
    availability: z.enum(['all', 'selected']).optional(),
    project: ProjectHandleSchema.optional(),
    spaceId: DurableNonEmptyScalarSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict()

const FacetCountSchema = z.number().int().nonnegative()

export const AgentPackageLibraryFacetsSchema = z.object({
  source: z.object({
    system: FacetCountSchema,
    catalog: FacetCountSchema,
    owned: FacetCountSchema,
  }),
  home: z.object({
    personal: FacetCountSchema,
    space: FacetCountSchema,
  }),
  availability: z.object({
    all: FacetCountSchema,
    selected: FacetCountSchema,
  }),
  projects: z.array(
    z.object({
      project: ProjectSummarySchema,
      count: FacetCountSchema,
    }),
  ),
})

export const AgentPackageLibraryPageSchema = {
  filteredTotal: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).max(1024).nullable(),
  facets: AgentPackageLibraryFacetsSchema,
}

export type AgentPackageLibraryQuery = z.infer<typeof AgentPackageLibraryQuerySchema>
export type AgentPackageLibraryQueryInput = z.input<typeof AgentPackageLibraryQuerySchema>
export type AgentPackageLibraryFacets = z.infer<typeof AgentPackageLibraryFacetsSchema>
