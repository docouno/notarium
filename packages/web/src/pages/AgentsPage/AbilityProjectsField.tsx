import type { AgentAbilityAvailabilityState, MeAgentSkillsResponse } from '@notarium/contract'
import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract/enums'
import { Checkbox } from '../../core/Checkbox'
import styles from './AbilityProjectsField.module.scss'

type Project = MeAgentSkillsResponse['projects'][number]

/** WHICH projects, never WHETHER all of them: "all projects" is the neighbouring
 *  answer everywhere this appears — the Ability aside asks it with the `Belongs to`
 *  segment, the Catalog dialog with its own switch — and a row for it here would be
 *  the same question twice, in two controls that can disagree. */
export const AbilityProjectsField = <P extends Project>({
  projects,
  mode,
  selected,
  valueOf,
  labelOf,
  onChange,
  disabled = false,
  emptyLabel = 'No projects are available.',
}: {
  projects: readonly P[]
  mode: AgentAbilityAvailabilityState['mode']
  selected: readonly string[]
  valueOf: (project: P) => string
  /** Human label; defaults to the display name so a handle is not a caption. */
  labelOf?: (project: P) => string
  onChange: (mode: AgentAbilityAvailabilityState['mode'], selected: string[]) => void
  disabled?: boolean
  /** What an empty list says; the caller knows which pool it offered. */
  emptyLabel?: string
}) => {
  const values = projects.map(valueOf)
  const selectedSet = new Set(selected)
  const all = mode === ABILITY_AVAILABILITY_MODE.allProjects

  const setProject = (value: string, checked: boolean) => {
    // A selection this list cannot SHOW is still a selection: the choices are the
    // projects the caller may pick from, filtered and capped, while the answer may
    // already cover a project outside them. Rebuilding the answer from the visible
    // rows would drop those bindings on an edit that never touched them.
    const current = all ? values : [...selected]
    const next = checked
      ? [...new Set([...current, value])]
      : current.filter((candidate) => candidate !== value)
    onChange(
      values.length > 0 && next.length === values.length
        ? ABILITY_AVAILABILITY_MODE.allProjects
        : ABILITY_AVAILABILITY_MODE.selectedProjects,
      next,
    )
  }

  return (
    <div className={styles.tree} role="group" aria-label="Available projects">
      {projects.map((project) => {
        const value = valueOf(project)
        return (
          <Checkbox
            key={project.id}
            checked={all || selectedSet.has(value)}
            disabled={disabled}
            onChange={(checked) => setProject(value, checked)}
            label={labelOf?.(project) ?? project.displayName}
            data-testid={`ability-availability-project-${project.id}`}
          />
        )
      })}
      {!projects.length && <small>{emptyLabel}</small>}
    </div>
  )
}
