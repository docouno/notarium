import { useState } from 'react'
import type {
  AddAgentRoleRequest,
  AddAgentSkillRequest,
  AgentAbilityAvailabilityState,
  MeAgentSkillsResponse,
} from '@notarium/contract'
import { ABILITY_AVAILABILITY_MODE, ABILITY_KIND, ROLE_SCOPE } from '@notarium/contract/enums'
import { FormDialog } from '../../core/FormDialog'
import { Segmented } from '../../core/Segmented'
import { Select } from '../../core/Select'
import { Switch } from '../../core/Switch'
import { errorText } from '../../libs/errors'
import { AbilityProjectsField } from './AbilityProjectsField'
import { projectChoiceLabels } from './helpers/format'
import styles from './CatalogAbilityAddDialog.module.scss'

type CatalogAddRequest = AddAgentRoleRequest | AddAgentSkillRequest
type Destination = 'personal' | 'shared'
// "All projects" and the ticked set are not two settings: a project list means
// nothing under "all projects", and holding them apart is what let the switch and the
// list disagree. One reach, in the wire's own shape.
const ALL_PROJECTS: AgentAbilityAvailabilityState = { mode: ABILITY_AVAILABILITY_MODE.allProjects }
const reachProjects = (reach: AgentAbilityAvailabilityState): string[] =>
  reach.mode === ABILITY_AVAILABILITY_MODE.selectedProjects ? reach.projectIds : []

export const CatalogAbilityAddDialog = ({
  kind,
  name,
  space,
  spaceAvailable,
  projects,
  onAdd,
  onClose,
}: {
  kind: 'role' | 'skill'
  name: string
  space: string
  spaceAvailable: boolean
  projects: MeAgentSkillsResponse['projects']
  onAdd: (input: CatalogAddRequest) => Promise<void>
  onClose: () => void
}) => {
  const [destination, setDestination] = useState<Destination>('personal')
  const [project, setProject] = useState('')
  const [reach, setReach] = useState<AgentAbilityAvailabilityState>(ALL_PROJECTS)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The destination is named ONCE, right above — this Space — and every project the
  // dialog offers has to live in it. The listings that feed this list are not all
  // scoped the same way (the library asks owner-globally on purpose, the detail page
  // asks per Space), so pairing the two is this dialog's job rather than each
  // caller's: a caller that got it wrong offered a project of another Space and the
  // add came back `404 not found`, with nothing naming the row at fault.
  const inSpace = projects.filter((entry) => entry.space === space)
  const projectOptions = projectChoiceLabels(inSpace)
  const allProjects = reach.mode === ABILITY_AVAILABILITY_MODE.allProjects
  const selectedProjects = reachProjects(reach)
  const sharedAvailable = kind === ABILITY_KIND.role ? inSpace.length > 0 : spaceAvailable
  const valid =
    destination === 'personal' ||
    (kind === ABILITY_KIND.role
      ? project.length > 0
      : spaceAvailable && (allProjects || selectedProjects.length > 0))

  const submit = async () => {
    if (!valid || busy) {
      return
    }
    const input: CatalogAddRequest =
      destination === 'personal'
        ? { name, scope: ROLE_SCOPE.personal }
        : kind === ABILITY_KIND.role
          ? { name, scope: ROLE_SCOPE.project, project }
          : {
              name,
              scope: ROLE_SCOPE.space,
              space,
              availability: allProjects
                ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
                : { mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projects: selectedProjects },
            }
    setBusy(true)
    setFailed(null)
    try {
      await onAdd(input)
    } catch (error) {
      setFailed(errorText(error))
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title={`Add ${name}`}
      description={`Choose where the Catalog ${kind} becomes an Owned package.`}
      dirty={destination !== 'personal' || project.length > 0 || !allProjects}
      busy={busy}
      error={failed}
      submitLabel={`Add ${kind}`}
      busyLabel="Adding…"
      submitDisabled={!valid}
      onSubmit={submit}
      onClose={onClose}
      size="sm"
      testId="catalog-ability-add-dialog"
      discardTitle={`Discard ${kind} placement?`}
      discardMessage="The Catalog package has not been added yet."
    >
      <div className={styles.field}>
        <span>Destination</span>
        <Segmented<Destination>
          value={destination}
          onChange={(next) => {
            setDestination(next)
            if (next === 'personal') {
              setProject('')
              setReach(ALL_PROJECTS)
            }
          }}
          options={[
            { value: 'personal', label: 'Personal' },
            {
              value: 'shared',
              label: kind === ABILITY_KIND.role ? 'Project' : 'Space',
              disabled: !sharedAvailable,
              title: sharedAvailable
                ? kind === ABILITY_KIND.role
                  ? `Project in ${space}`
                  : `Space · ${space}`
                : `No writable ${
                    kind === ABILITY_KIND.role ? 'project' : 'shared space'
                  } is selected`,
            },
          ]}
          ariaLabel={`${kind} destination`}
          block
          disabled={busy}
        />
      </div>

      {destination === 'shared' && kind === ABILITY_KIND.role && (
        <label className={styles.field}>
          <span>Project</span>
          <Select
            value={project}
            options={[
              { value: '', label: 'Choose a project' },
              ...projectOptions.map((entry) => ({ value: entry.handle, label: entry.label })),
            ]}
            onChange={setProject}
            disabled={busy}
            elevated
            data-testid="catalog-add-project"
          />
        </label>
      )}

      {destination === 'shared' && kind === ABILITY_KIND.skill && (
        <section className={styles.availability}>
          <div className={styles.availabilityHead}>
            <div>
              <strong>Project availability</strong>
              <small>Choose which projects in {space} can load this skill.</small>
            </div>
            <Switch
              checked={allProjects}
              onChange={(checked) =>
                setReach(
                  checked
                    ? ALL_PROJECTS
                    : { mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projectIds: [] },
                )
              }
              label="All projects"
              disabled={busy}
              data-testid="catalog-add-all-projects"
            />
          </div>
          {!allProjects && (
            <div className={styles.projects}>
              <AbilityProjectsField
                projects={projectOptions}
                mode={ABILITY_AVAILABILITY_MODE.selectedProjects}
                selected={selectedProjects}
                valueOf={(entry) => entry.handle}
                labelOf={(entry) => entry.label}
                disabled={busy}
                emptyLabel="No projects are available in this space."
                // The whole-Space answer is the switch above, not a tick of every row:
                // covering every project that exists TODAY is a different promise from
                // covering the ones added tomorrow, and this dialog asks it once.
                onChange={(_mode, projectIds) =>
                  setReach({ mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projectIds })
                }
              />
              {!selectedProjects.length && (
                <small>Pick at least one project, or allow all projects.</small>
              )}
            </div>
          )}
        </section>
      )}
    </FormDialog>
  )
}
