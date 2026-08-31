import { lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import type {
  AbilitySkillLocator,
  AgentAbilitySummary,
  MeAgentSkillsResponse,
} from '@notarium/contract'
import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  ABILITY_SOURCE,
  ROLE_SCOPE,
} from '@notarium/contract/enums'
import { serializeAbilityLocator } from '@notarium/core'
import { useChrome } from '../../composers/ChromeProvider'
import { useEditing } from '../../composers/EditingProvider'
import { useHotkeys } from '../../composers/HotkeysProvider'
import { AsideField, AsidePanel, AsideValue } from '../../core/AsidePanel'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { IconEdit, IconEye } from '../../core/Icons'
import { Segmented } from '../../core/Segmented'
import { Skeleton, SkeletonText } from '../../core/Skeleton'
import { Textarea } from '../../core/Textarea'
import { useEditorPreview } from '../../layouts/DocumentLayout/hooks/useEditorPreview'
import { editorBindings } from '../../libs/hotkeys'
import { loadEditorBody, useLazyEditorAutoFocus } from '../../widgets/EditorBody'
import { AbilityProjectsField } from './AbilityProjectsField'
import { AgentsPanel } from './AgentsPanel'
import { useAgentsShell } from './AgentsProvider'
import { projectChoiceLabels } from './helpers/format'
import styles from './AbilityEditorSurface.module.scss'

const EditorBody = lazy(loadEditorBody)

const EditorLoadingSkeleton = () => (
  <div
    className={styles.editorLoadingSkeleton}
    data-testid="editor-loading-skeleton"
    aria-hidden="true"
  >
    <Skeleton w="64%" h={32} />
    <SkeletonText lines={4} lastWidth="54%" />
    <SkeletonText lines={5} lastWidth="38%" />
  </div>
)

/** A skill this role may attach: the server judges it in EVERY project the role
 *  covers, so the editor offers exactly the same set. A skill that reaches two of the
 *  three projects a role covers would leave it fail-closed in the third. `covered`
 *  empty means the role covers whatever its Space does — so only an all-projects
 *  skill qualifies. */
const eligibleSkills = (
  skills: readonly AgentAbilitySummary[],
  home: 'personal' | 'space',
  spaceId: string,
  covered: readonly string[],
): AgentAbilitySummary[] =>
  skills.filter((ability) => {
    if (ability.locator.kind !== ABILITY_KIND.skill || ability.source === ABILITY_SOURCE.catalog) {
      return false
    }
    if ('enabled' in ability && !ability.enabled) {
      return false
    }
    if (ability.source === ABILITY_SOURCE.system) {
      return true
    }
    const location = ability.locator.location

    if (home === ROLE_SCOPE.personal) {
      return location.scope === ROLE_SCOPE.personal
    }
    if (location.scope !== ROLE_SCOPE.space || location.spaceId !== spaceId) {
      return false
    }
    if (ability.availability?.mode === ABILITY_AVAILABILITY_MODE.allProjects) {
      return true
    }
    const reach = ability.availability?.projectIds ?? []

    return covered.length > 0 && covered.every((projectId) => reach.includes(projectId))
  })

/** Where an ability belongs, and — when it can change — what it may become. The
 *  caller resolves the words because it is the only layer that knows the Space and
 *  the project by name; the editor only asks the question. */
type AbilityPlacement = {
  /** What it belongs to right now, named the way the user named it. */
  label: string
  /** The ability's own Space, by its own name — never "this space", which stops
   *  being true the moment a role can live in more than one. */
  spaceLabel: string
  /** May it change? */
  movable: boolean
  /** Why not, when not — a disabled option that gives no reason sends the user
   *  looking for a setting that does not exist. */
  fixedReason?: string
  /** The Space role this project role overrides, when there is one. */
  overrides?: string
}

export const AbilityEditorSurface = ({
  projects,
  skills,
  placement,
  personalAvailable = true,
  spaceAvailable = true,
}: {
  projects: MeAgentSkillsResponse['projects']
  skills: AgentAbilitySummary[]
  placement?: AbilityPlacement
  personalAvailable?: boolean
  spaceAvailable?: boolean
}) => {
  const { actionsHost } = useAgentsShell()
  const { draft, editor, saving, saveDraft, cancelEdit, ensureCanLeaveDraft } = useEditing()
  const { editorMode, focusMode, setFocusMode, typewriter, toggleFocus, toggleTypewriter } =
    useChrome()
  const { resolved } = useHotkeys()
  const { editorPreview, setEditorPreview, editorKey } = useEditorPreview(draft)
  const shouldAutoFocusEditor = useLazyEditorAutoFocus(true, editorKey)

  // Unreachable from either caller, and it has to stay that way: this component OWNS the
  // route's aside (#393), so a render that returns nothing would take the panel with it.
  // `AbilityDetailPage` and `AbilityDraftPage` both check the same draft before handing
  // the route over, and both seed `abilityKind` on the session they check.
  if (!draft || !editor.isAbility || !editor.abilityKind) {
    return null
  }
  const projectOptions = projectChoiceLabels(projects)
  // The answer is already in project ids — the identity the server states reaches in.
  const coveredProjects =
    editor.abilityAvailability === ABILITY_AVAILABILITY_MODE.selectedProjects
      ? editor.abilityProjects
      : draft.abilityLocator?.location.scope === ROLE_SCOPE.project
        ? [draft.abilityLocator.location.projectId]
        : []
  const availableSkills = eligibleSkills(
    skills,
    editor.abilityHome,
    editor.abilitySpaceId,
    coveredProjects,
  )
  const attached = new Set(
    editor.attachments.flatMap((attachment) =>
      attachment.kind === 'exact' ? [serializeAbilityLocator(attachment.locator)] : [],
    ),
  )
  const eligibleKeys = new Set(
    availableSkills.map((ability) => serializeAbilityLocator(ability.locator)),
  )
  const skillsByKey = new Map(
    skills.map((ability) => [serializeAbilityLocator(ability.locator), ability] as const),
  )
  const skillGroups = [
    {
      id: 'personal',
      label: 'Personal',
      items: availableSkills.filter(
        (ability) =>
          ability.source === ABILITY_SOURCE.owned &&
          ability.locator.location.scope === ROLE_SCOPE.personal,
      ),
    },
    {
      id: 'space',
      label: 'Space',
      items: availableSkills.filter(
        (ability) =>
          ability.source === ABILITY_SOURCE.owned &&
          ability.locator.location.scope === ROLE_SCOPE.space,
      ),
    },
    {
      id: 'system',
      label: 'System',
      items: availableSkills.filter((ability) => ability.source === ABILITY_SOURCE.system),
    },
  ].filter((group) => group.items.length > 0)
  const unavailableAttachments = editor.attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(
      ({ attachment }) =>
        attachment.kind === 'invalid' ||
        !eligibleKeys.has(serializeAbilityLocator(attachment.locator)),
    )

  const setAttachment = (ability: AgentAbilitySummary, checked: boolean) => {
    if (ability.locator.kind !== ABILITY_KIND.skill || ability.source === ABILITY_SOURCE.catalog) {
      return
    }
    const key = serializeAbilityLocator(ability.locator)

    if (!checked) {
      editor.setAttachments(
        editor.attachments.filter(
          (attachment) =>
            attachment.kind !== 'exact' || serializeAbilityLocator(attachment.locator) !== key,
        ),
      )
      return
    }

    if (attached.has(key)) {
      return
    }
    const locator = ability.locator as AbilitySkillLocator
    // Exact attachment labels are part of the locator wire and deliberately keep
    // the stable machine name. Human titles are resolved for display from the
    // inventory, just like the rest of the Ability UI.
    editor.setAttachments([...editor.attachments, { kind: 'exact', locator, label: ability.name }])
  }
  const detachAttachmentAt = (index: number) =>
    editor.setAttachments(editor.attachments.filter((_, candidate) => candidate !== index))
  const actions = (
    <>
      <Button
        variant={editor.dirty ? 'danger' : 'ghost'}
        disabled={saving}
        onClick={() =>
          void ensureCanLeaveDraft().then((ok) => {
            if (ok) {
              cancelEdit()
            }
          })
        }
      >
        Cancel
      </Button>
      <Button variant="ghost" disabled={saving} onClick={() => setEditorPreview((value) => !value)}>
        {editorPreview ? <IconEdit size={15} /> : <IconEye size={15} />}
        {editorPreview ? 'Edit' : 'Preview'}
      </Button>
      <Button
        variant="primary"
        disabled={!editor.canSave || saving}
        onClick={() => void saveDraft(editor.buildPayload())}
        data-testid="ability-save"
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </>
  )
  const published = draft.abilityLocator != null
  // ONE question, one list. `Space` means the whole Space — every project it has and
  // every project it will have. `Projects` means these projects and no others. There
  // is no second list underneath either answer, because there never were two
  // questions: what used to be a separate reach field IS this answer.
  //
  // An override is deliberately NOT expressed here. It is "this project needs a
  // different text", which is `Add version` and the `Versions`/`Overrides` links — a
  // relation between two bodies, not a place.
  const scopeOptions = [
    {
      value: 'personal' as const,
      label: 'Personal',
      disabled: published || !personalAvailable,
      ...(published
        ? { title: 'Moving between Personal and a Space is not available yet' }
        : !personalAvailable
          ? { title: 'Personal installation is unavailable on this host' }
          : {}),
    },
    {
      value: 'space' as const,
      label: placement?.spaceLabel ?? 'Space',
      disabled: published ? !placement?.movable : !spaceAvailable,
      ...(published && !placement?.movable && placement?.fixedReason
        ? { title: placement.fixedReason }
        : !published && !spaceAvailable
          ? { title: 'Space installation is unavailable on this host' }
          : {}),
    },
    {
      value: 'projects' as const,
      label: 'Projects',
      disabled: published
        ? !placement?.movable || !projects.length
        : !spaceAvailable || !projects.length,
      ...(published && !placement?.movable && placement?.fixedReason
        ? { title: placement.fixedReason }
        : !published && !spaceAvailable
          ? { title: 'Project installation is unavailable on this host' }
          : !published && !projects.length
            ? { title: 'No projects are available in this Space' }
            : {}),
    },
  ]
  // The editor still carries the domain's own three placements; this control speaks
  // the product's. `Projects` is a Space home whose reach is a chosen set — one role,
  // one package, several projects, which is exactly what a copy used to stand in for.
  const scope =
    editor.abilityHome === ROLE_SCOPE.personal
      ? ('personal' as const)
      : editor.abilityAvailability === ABILITY_AVAILABILITY_MODE.allProjects
        ? ('space' as const)
        : ('projects' as const)

  const aside = (
    <AsidePanel testId="ability-editor-aside">
      <AsideField label="Description">
        <Textarea
          value={editor.abilityDescription}
          maxLength={1024}
          rows={4}
          onChange={(event) => editor.setAbilityDescription(event.target.value)}
          placeholder={`What this ${editor.abilityKind} helps an agent do (optional)`}
          aria-label="Ability description"
          data-testid="ability-description"
        />
      </AsideField>
      <AsideField label="Belongs to">
        <Segmented
          value={scope}
          options={scopeOptions}
          onChange={(next) => {
            editor.setAbilityHome(next === 'personal' ? ROLE_SCOPE.personal : ROLE_SCOPE.space)
            editor.setAbilityAvailability(
              next === 'projects'
                ? ABILITY_AVAILABILITY_MODE.selectedProjects
                : ABILITY_AVAILABILITY_MODE.allProjects,
            )
            // The ticks are REMEMBERED across the switch. Answering `Space` and
            // changing your mind is not an edit of which projects were chosen, so
            // the set comes back as it was — dropping it would silently rewrite an
            // answer the user never touched. Only a set that has never been chosen
            // gets a starting point, and that is everything the ability reaches now.
            if (next === 'projects' && editor.abilityProjects.length === 0) {
              editor.setAbilityProjects(projectOptions.map((entry) => entry.id))
            }
          }}
          ariaLabel="Belongs to"
          block
        />
      </AsideField>
      {published && placement?.overrides && (
        <AsideField label="Overrides">
          <AsideValue>{placement.overrides}</AsideValue>
        </AsideField>
      )}
      {scope === 'projects' && (
        <AsideField label="Projects">
          <AbilityProjectsField
            projects={projectOptions}
            mode={ABILITY_AVAILABILITY_MODE.selectedProjects}
            selected={editor.abilityProjects}
            valueOf={(entry) => entry.id}
            labelOf={(entry) => entry.label}
            onChange={(_mode, selected) => {
              editor.setAbilityAvailability(ABILITY_AVAILABILITY_MODE.selectedProjects)
              editor.setAbilityProjects(selected)
            }}
          />
        </AsideField>
      )}

      {editor.abilityKind === ABILITY_KIND.role && (
        <AsideField label="Skills">
          <div className={styles.skillTree}>
            {skillGroups.map((group) => (
              <div key={group.id} className={styles.skillGroup}>
                <h3>{group.label}</h3>
                {group.items.map((ability) => {
                  const key = serializeAbilityLocator(ability.locator)
                  return (
                    <Checkbox
                      key={key}
                      checked={attached.has(key)}
                      onChange={(checked) => setAttachment(ability, checked)}
                      label={ability.title}
                    />
                  )
                })}
              </div>
            ))}
            {unavailableAttachments.length > 0 && (
              <div className={styles.skillGroup}>
                <h3>Unavailable</h3>
                {unavailableAttachments.map(({ attachment, index }) => {
                  const resolvedSkill =
                    attachment.kind === 'exact'
                      ? skillsByKey.get(serializeAbilityLocator(attachment.locator))
                      : null
                  const label =
                    attachment.kind === 'exact'
                      ? (resolvedSkill?.title ?? attachment.label)
                      : attachment.raw
                  return (
                    <Checkbox
                      key={`${index}:${JSON.stringify(attachment)}`}
                      checked
                      onChange={(checked) => {
                        if (!checked) {
                          detachAttachmentAt(index)
                        }
                      }}
                      label={
                        <span className={styles.skillLabel}>
                          <span>{label}</span>
                          <small>Unavailable · uncheck to detach</small>
                        </span>
                      }
                    />
                  )
                })}
              </div>
            )}
            {!skillGroups.length && !unavailableAttachments.length && (
              <small>No eligible skills.</small>
            )}
          </div>
        </AsideField>
      )}
    </AsidePanel>
  )

  return (
    <div className={styles.page} data-testid="ability-editor">
      <Suspense fallback={<EditorLoadingSkeleton />}>
        <EditorBody
          key={editorKey}
          editor={editor}
          preview={editorPreview}
          mode={editorMode === 'wysiwym' ? 'wysiwym' : 'source'}
          focus={focusMode}
          typewriter={typewriter}
          onSetFocus={setFocusMode}
          onToggleFocus={toggleFocus}
          onToggleTypewriter={toggleTypewriter}
          editorKeys={editorBindings(resolved)}
          shouldAutoFocus={shouldAutoFocusEditor}
        />
      </Suspense>
      {actionsHost ? createPortal(actions, actionsHost) : null}
      <AgentsPanel
        panels={[{ id: 'details', label: 'Details', render: () => aside }]}
        defaultLayout={[{ panels: ['details'], activeTab: 'details' }]}
        label={`${editor.abilityKind} details`}
      />
    </div>
  )
}
