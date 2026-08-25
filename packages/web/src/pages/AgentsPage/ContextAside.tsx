import { Link } from 'react-router'
import type {
  ProjectAgentContext,
  ProjectRow,
  RoleContextIdentity,
  Space,
} from '@notarium/contract'
import { ROLE_SCOPE } from '@notarium/contract/enums'
import { AsideField, AsidePanel, AsideValue } from '../../core/AsidePanel'
import { Skeleton } from '../../core/Skeleton'
import { agentAbilityRoute } from '../../libs/routing/routePaths'
import { projectLabel } from './helpers/format'

/** Only the lengths are read here — which is why the three scopes, whose rows are three
 *  different shapes, are one type to this panel. */
type Counted = { pins: readonly unknown[]; sets: readonly unknown[] }

// The Context aside (#393): a READ-ONLY witness for the scope the page is showing —
// which role actually resolved and where it lives, how much is in the active scope, and
// the project's auto index. Not a second control surface: `asideOpen` is one global
// preference defaulting to closed, so anything that lives only here does not exist for
// most readers. That is why the role notices and the scale stay in the page body.
export const ContextAside = ({
  loading,
  roleFailed,
  scopeFailed,
  roleUnavailable,
  roleLayer,
  isRoleScope,
  isProjectScope,
  roleRoute,
  projectRoute,
  project,
  personal,
  spaces,
  projects,
}: {
  /** The page has no answer for this scope yet (`!contextIsCurrent`). */
  loading: boolean
  /** The identity door did not answer for a role the address names. */
  roleFailed: boolean
  /** The preview door did not answer for the scope the body renders. */
  scopeFailed: boolean
  roleUnavailable: boolean
  roleLayer: RoleContextIdentity | undefined
  isRoleScope: boolean
  isProjectScope: boolean
  /** The address NAMES a role, so a placement will be stated once the door answers. Both
   *  this and `projectRoute` exist for the same reason: the fields a settled address will
   *  show are reserved while it loads, or the panel gains a row mid-read — the jump this
   *  aside exists to remove. Each is dropped the moment the page knows the address will
   *  not settle there, so a reserved row is never taken back except by a state the reader
   *  caused (a role that no longer resolves also gets a notice and a rewritten URL). */
  roleRoute: boolean
  /** The address SETTLES into the project scope — the same prediction the page's own
   *  effect makes. See `roleRoute` for why it is reserved at all. */
  projectRoute: boolean
  project: ProjectAgentContext | null
  personal: Counted | null | undefined
  spaces: readonly Space[]
  projects: readonly ProjectRow[] | null
}) => {
  // Keyed by the same expressions the body renders by, never by the bare active scope:
  // a role the preview refuses still renders its own layer, and a role whose door failed
  // falls through to the profile — in both cases the panel has to say what the body says.
  const composition: Counted | null = isRoleScope
    ? (roleLayer ?? null)
    : isProjectScope
      ? project
      : (personal ?? null)
  const location = roleLayer?.locator.location
  const spaceName = location && spaces.find((entry) => entry.id === location.spaceId)?.displayName
  const roleProject =
    location?.scope === ROLE_SCOPE.project
      ? projects?.find((entry) => entry.id === location.projectId)
      : undefined
  // Never the raw address: on the wire the layer carries a slug and a handle, and a role
  // addressed from Personal usually lives in a Space this reader does not have listed.
  const placement =
    location?.scope === ROLE_SCOPE.personal
      ? 'Personal'
      : location?.scope === ROLE_SCOPE.space
        ? (spaceName ?? 'the Space')
        : [roleProject ? projectLabel(roleProject) : 'This project', spaceName]
            .filter(Boolean)
            .join(' · ')
  // A missing answer is still an answer: the panel says which door failed, and only
  // skeletons what is genuinely still in flight. `failed` outranks `loading` for the same
  // reason the body shows the error instead of the meter's skeleton.
  const missing = scopeFailed ? <AsideValue>Couldn’t load</AsideValue> : <Skeleton w="58%" h={13} />

  return (
    <AsidePanel testId="context-details">
      {!roleUnavailable && (
        <AsideField label="Effective role">
          {roleFailed ? (
            <AsideValue>Couldn’t load the role</AsideValue>
          ) : loading ? (
            <Skeleton w="66%" h={13} />
          ) : roleLayer ? (
            <Link to={agentAbilityRoute(roleLayer.locator)}>
              {roleLayer.title ?? roleLayer.name}
            </Link>
          ) : (
            // Nothing addressed the role, so nothing resolved one: `role` is required in
            // the door's answer, and the two ways it can be missing are read above.
            <AsideValue>Base context</AsideValue>
          )}
        </AsideField>
      )}
      {!roleUnavailable && !roleFailed && (roleLayer || (roleRoute && loading)) && (
        <AsideField label="Placement">
          {roleLayer ? <AsideValue>{placement}</AsideValue> : <Skeleton w="52%" h={13} />}
        </AsideField>
      )}
      <AsideField label="Composition">
        {composition ? (
          <AsideValue>
            {composition.pins.length} pinned · {composition.sets.length}{' '}
            {composition.sets.length === 1 ? 'set' : 'sets'}
          </AsideValue>
        ) : (
          missing
        )}
      </AsideField>
      {(isProjectScope || (projectRoute && loading)) && (
        <AsideField label="Auto">
          {project ? (
            <AsideValue>
              {project.index.noteCount} notes · {project.index.folderCount} folders + recent changes
            </AsideValue>
          ) : (
            missing
          )}
        </AsideField>
      )}
    </AsidePanel>
  )
}
