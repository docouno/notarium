import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AUTH_MODE } from '@notarium/contract/enums'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { IconChevron, IconPlus, IconSettings, IconUser, IconWorkspace } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { errorText } from '../../libs/errors'
import { workspaceSettingsRoute } from '../../libs/routing/routePaths'
import { useAuth } from '../AuthProvider'
import { useSpace } from '../SpaceProvider'
import styles from './Sidebar.module.scss'

// The space switcher (#16): which base the whole rail (and every space-scoped
// page) is looking at. Reuses the shared ContextMenu popover, same as the
// settings button. Hidden entirely on a single-space host without the create
// capability — the chrome must not advertise a concept the deployment doesn't
// have (an operator-static host doesn't mint spaces; creation arrives with the
// engine that owns namespaces, #69).
export const SpaceSwitcher = () => {
  const { space, spaces, personalSpace, capabilities, switchSpace, createSpace } = useSpace()
  const { mode, me } = useAuth()
  const { prompt, alert } = useDialog()
  const navigate = useNavigate()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const user = mode === AUTH_MODE.password ? me : null
  const active = spaces.find((s) => s.slug === space)
  // The personal domain (#13) is a switchable destination but lives outside the
  // workspace list — so the active label/icon must resolve it explicitly, else
  // reading an about-you memory note shows a raw slug in the switcher button.
  const onPersonal = personalSpace?.slug === space
  const activeLabel = active?.displayName ?? (onPersonal ? personalSpace!.displayName : space)
  // Workspace settings (#28, #13) — projects + members — exist once there's a
  // signed-in user and a space to manage. The personal domain is a manageable
  // space too (projects live there; only inviting is off), but it's filtered out
  // of `spaces`, so admit it explicitly via onPersonal.
  const showWorkspaceSettings = user != null && (active != null || onPersonal)

  // A multi-user host always shows the switcher: even single-space it carries
  // the workspace-settings entry, and a personal domain is its own destination.
  // Otherwise the pre-#10 rule — don't advertise a concept the deployment lacks.
  if (spaces.length <= 1 && !capabilities.spaceCreate && !showWorkspaceSettings && !personalSpace) {
    return null
  }
  const onCreate = async () => {
    // Ask for a human NAME, not a slug: typing "Public Space" used to fail with "bad
    // space slug". The server derives the URL handle from the name (#123, any language —
    // Latin/Cyrillic/Greek romanise, a non-romanisable name gets an id-shaped handle),
    // soft-suffixes a clash, and the handle stays renameable later in General.
    const name = await prompt({
      title: 'New space',
      message:
        'Name your workspace — e.g. “Public Space”. Its URL handle is made from the name and can be changed later in the space’s General settings.',
      placeholder: 'e.g. Public Space',
      confirmLabel: 'Create',
    })

    if (!name?.trim()) {
      return
    }
    try {
      await createSpace(name.trim())
    } catch (e) {
      await alert({ title: 'Could not create space', message: errorText(e), danger: true })
    }
  }
  const items: MenuItem[] = [
    ...spaces.map((s) => ({
      label: s.displayName,
      radioGroup: 'Workspace',
      icon: <IconWorkspace size={14} />,
      active: s.slug === space,
      onClick: () => switchSpace(s.slug),
    })),
    // The personal domain (#13) — always reachable, sitting with the workspaces
    // but set apart by the user glyph alone (no divider: the icon already marks it
    // as the personal destination, a rule, not a separate group).
    ...(personalSpace
      ? [
          {
            label: personalSpace.displayName,
            radioGroup: 'Workspace',
            icon: <IconUser size={14} />,
            active: onPersonal,
            onClick: () => switchSpace(personalSpace.slug),
          },
        ]
      : []),
    ...(showWorkspaceSettings
      ? [
          { divider: true } as MenuItem,
          {
            label: 'Management',
            icon: <IconSettings size={14} />,
            onClick: () =>
              navigate(workspaceSettingsRoute(space, onPersonal ? 'projects' : undefined)),
          },
        ]
      : []),
    ...(capabilities.spaceCreate
      ? [
          { divider: true } as MenuItem,
          { label: 'New space', icon: <IconPlus size={14} />, onClick: () => void onCreate() },
        ]
      : []),
  ]
  const rect = open && ref.current ? ref.current.getBoundingClientRect() : null
  return (
    <div className={styles.spaceSwitcher}>
      <button
        ref={ref}
        className={cx(styles.navItemBtn, styles.spaceSwitcherBtn, open && styles.menuOpen)}
        data-testid="space-switcher"
        title="Switch space"
        onClick={() => setOpen((o) => !o)}
      >
        {onPersonal ? <IconUser size={15} /> : <IconWorkspace size={15} />}
        <span className={styles.navLabel}>{activeLabel}</span>
        <span className={styles.spaceSwitcherChev}>
          <IconChevron size={12} />
        </span>
      </button>
      {rect && (
        <ContextMenu
          x={rect.left}
          y={rect.bottom + 4}
          ignoreRef={ref}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
