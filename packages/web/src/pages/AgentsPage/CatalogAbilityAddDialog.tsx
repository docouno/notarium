import { useState } from 'react'
import type {
  AddAgentRoleRequest,
  AddAgentSkillRequest,
  AgentAbilityAvailabilityState,
  MeAgentRolesResponse,
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
const INSTALL_ERROR_REASONS = {
  role_install_unavailable:
    'This host cannot install packages in that location. Reload and try again.',
}

/** The two library answers stay domain-named on the wire; this shared surface
 *  normalizes them only after it knows which kind it is rendering. A missing
 *  field or key remains unavailable, so an older response fails closed. */
export type CatalogInstallAvailability =
  | NonNullable<MeAgentRolesResponse['installAvailability']>
  | NonNullable<MeAgentSkillsResponse['installAvailability']>
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
  install,
  onAdd,
  onClose,
}: {
  kind: 'role' | 'skill'
  name: string
  space: string
  spaceAvailable: boolean
  projects: MeAgentSkillsResponse['projects']
  install?: CatalogInstallAvailability
  onAdd: (input: CatalogAddRequest) => Promise<void>
  onClose: () => void
}) => {
  const canInstallPersonal = install?.personal ?? false
  const targetAvailability = install
    ? 'projects' in install
      ? install.projects
      : install.spaces
    : {}
  // The destination names one Space. A library listing may be owner-global, so
  // project choices are narrowed here before either availability or defaults are
  // derived from them.
  const inSpace = projects.filter((entry) => entry.space === space)
  const installable = inSpace.filter((entry) => targetAvailability[entry.handle] ?? false)
  const firstProject = kind === ABILITY_KIND.role ? (installable[0]?.handle ?? '') : ''
  // Personal first when the host can take it, otherwise the shared destination —
  // never a target the reader would have to discover is refused. Settled once, at
  // open: the dialog is short-lived and the listing behind it does not change
  // under it.
  const initialDestination: Destination = canInstallPersonal ? 'personal' : 'shared'
  const initialProject = initialDestination === 'shared' ? firstProject : ''
  const [destination, setDestination] = useState<Destination>(initialDestination)
  const [project, setProject] = useState(initialProject)
  const [reach, setReach] = useState<AgentAbilityAvailabilityState>(ALL_PROJECTS)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // Offered, not merely disabled: a target this host cannot publish to is not a
  // choice the reader can make, and leaving it selectable only moves the refusal
  // to after the click.
  const projectOptions = projectChoiceLabels(kind === ABILITY_KIND.role ? installable : inSpace)
  const allProjects = reach.mode === ABILITY_AVAILABILITY_MODE.allProjects
  const selectedProjects = reachProjects(reach)
  const canInstallShared =
    kind === ABILITY_KIND.role ? installable.length > 0 : (targetAvailability[space] ?? false)
  const sharedAvailable =
    canInstallShared && (kind === ABILITY_KIND.role ? inSpace.length > 0 : spaceAvailable)
  const nowhereToInstall = !canInstallPersonal && !sharedAvailable
  const selectedProjectInstallable = installable.some((entry) => entry.handle === project)
  const valid =
    (destination === 'personal'
      ? canInstallPersonal
      : sharedAvailable &&
        (kind === ABILITY_KIND.role
          ? selectedProjectInstallable
          : allProjects || selectedProjects.length > 0)) && !nowhereToInstall

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
      setFailed(errorText(error, INSTALL_ERROR_REASONS))
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title={`Add ${name}`}
      description={`Choose where the Catalog ${kind} becomes an Owned package.`}
      dirty={destination !== initialDestination || project !== initialProject || !allProjects}
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
      {nowhereToInstall && (
        <p className={styles.notice} data-testid="catalog-add-unavailable">
          This host cannot install {kind} packages. Reading and previewing the Catalog still works;
          adding one needs storage that can publish a package directory atomically.
        </p>
      )}
      <div className={styles.field}>
        <span>Destination</span>
        <Segmented<Destination>
          value={destination}
          onChange={(next) => {
            setDestination(next)
            if (next === 'personal') {
              setProject('')
              setReach(ALL_PROJECTS)
            } else if (kind === ABILITY_KIND.role && !project) {
              setProject(firstProject)
            }
          }}
          options={[
            {
              value: 'personal',
              label: 'Personal',
              disabled: !canInstallPersonal,
              ...(canInstallPersonal ? {} : { title: 'This host cannot install packages there' }),
            },
            {
              value: 'shared',
              label: kind === ABILITY_KIND.role ? 'Project' : 'Space',
              disabled: !sharedAvailable,
              title: sharedAvailable
                ? kind === ABILITY_KIND.role
                  ? `Project in ${space}`
                  : `Space · ${space}`
                : canInstallShared
                  ? `No writable ${
                      kind === ABILITY_KIND.role ? 'project' : 'shared space'
                    } is selected`
                  : 'This host cannot install packages there',
            },
          ]}
          ariaLabel={`${kind} destination`}
          block
          disabled={busy}
        />
      </div>

      {destination === 'shared' && sharedAvailable && kind === ABILITY_KIND.role && (
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

      {destination === 'shared' && sharedAvailable && kind === ABILITY_KIND.skill && (
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
