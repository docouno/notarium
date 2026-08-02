import { useCallback, useState } from 'react'
import type { ProjectRow } from '@notarium/contract'

import { useProjects } from '../../composers/ProjectsProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { SettingsSection } from '../../core/SettingsSection'
import { Skeleton } from '../../core/Skeleton'
import { StateView } from '../../core/StateView'
import { Switch } from '../../core/Switch'
import { useToast } from '../../core/Toast'
import { cx } from '../../libs/cx/cx'
import styles from './ProjectsTab.module.scss'

// Projects section (#13, #28): the per-space management surface for the project
// model. The space ROOT is ALWAYS the first row, toggled on/off by its own switch
// (the zero-touch onboarding affordance — content can live outside projects, F3);
// when off it's greyed, not hidden, so the option is always discoverable. Below it
// sit the folders marked as projects from the tree, each removable via Unmark.
// Marking is a human act (the agent never creates containers). Reads + writes go
// through ProjectsProvider — the SAME state the tree's badges/menu use, so a folder
// marked from the tree shows up here and vice-versa, with no second fetch.
export const ProjectsTab = () => {
  const { space, spaces, personalSpace } = useSpace()
  const { projects, error, canManage, projectAt, mark, unmark, reload } = useProjects()
  const active = spaces.find((s) => s.slug === space)
  // The personal domain is filtered out of `spaces`, so resolve its display name
  // from personalSpace — else marking its root would mint with an empty name.
  const spaceName =
    active?.displayName ?? (personalSpace?.slug === space ? personalSpace.displayName : undefined)

  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const root = projectAt('')
  // A root project's handle collapses to just the space slug (#13) — that is also
  // the handle the root WOULD take once marked, so it's shown (greyed) while off.
  const rootHandle = root?.handle ?? space
  const others = (projects ?? []).filter((p) => p.path !== '')

  const toggleRoot = useCallback(
    async (on: boolean) => {
      setBusy(true)
      try {
        if (on) {
          await mark('', spaceName)
        } else if (root) {
          await unmark(root.id)
        }
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [spaceName, root, mark, unmark, toast],
  )

  return (
    <SettingsSection
      title="Projects"
      description="A project is a marked folder an agent can address by handle. Toggle the space root to give an agent a zero-touch place to write, or mark individual folders from the tree."
    >
      {error ? (
        <StateView
          tone="error"
          title="Couldn't load projects"
          description={error}
          actions={<Button onClick={() => void reload()}>Retry</Button>}
        />
      ) : projects === null ? (
        // First load — shimmer rows shaped like the project rows (canon #65: a
        // skeleton in the shape of its target, not a bare "Loading…").
        <ul className={styles.list} aria-hidden="true" data-testid="projects-loading">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className={styles.row}>
              <Skeleton w="7rem" h={14} radius={4} />
              <Skeleton w={`${30 + i * 10}%`} h={13} radius={4} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className={styles.list} data-testid="projects-list">
          {/* The space root — ALWAYS listed, toggled by its switch (greyed when
              off). The "mark root" onboarding affordance lives in-list now. */}
          <li className={cx(styles.row, !root && styles.rowOff)} data-testid="root-project-row">
            <span className={styles.handle}>{rootHandle}</span>
            <span className={styles.path}>(root)</span>
            <Switch
              className={styles.rowSwitch}
              checked={Boolean(root)}
              onChange={(on) => void toggleRoot(on)}
              disabled={!canManage || busy}
              aria-label="Mark the space root as a project"
              data-testid="mark-root-project"
            />
          </li>
          {others.map((p) => (
            <ProjectRow key={p.id} project={p} canManage={canManage} />
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}

// One non-root project row (#13 + #100 phase 2). Read mode shows the handle, path and
// any old handles that still resolve (the alias history); Rename swaps in an
// inline form for the slug + displayName. The slug is the durable handle — a
// changed one retires the old slug into the alias history server-side (so old
// `space/<slug>` links don't break), which is why renaming is safe to expose here.
// Self-contained edit/busy state (each row renames independently); reads rename/
// unmark + toast straight from context, no prop drilling.
const ProjectRow = ({ project, canManage }: { project: ProjectRow; canManage: boolean }) => {
  const { rename, unmark } = useProjects()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [slug, setSlug] = useState(project.slug)
  const [name, setName] = useState(project.displayName)
  const [busy, setBusy] = useState(false)

  const startEdit = useCallback(() => {
    setSlug(project.slug)
    setName(project.displayName)
    setEditing(true)
  }, [project.slug, project.displayName])

  const save = useCallback(async () => {
    const patch: { slug?: string; displayName?: string } = {}

    if (slug.trim() && slug.trim() !== project.slug) {
      patch.slug = slug.trim()
    }
    if (name.trim() && name.trim() !== project.displayName) {
      patch.displayName = name.trim()
    }
    if (!patch.slug && !patch.displayName) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await rename(project.id, patch)
      setEditing(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [slug, name, project.id, project.slug, project.displayName, rename, toast])

  const remove = useCallback(async () => {
    setBusy(true)
    try {
      await unmark(project.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [unmark, project.id, toast])

  if (editing) {
    return (
      <li className={styles.row}>
        <div className={styles.editForm}>
          <input
            className={cx(styles.input, styles.inputSlug)}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="slug"
            aria-label="Project slug"
            data-testid="project-slug-input"
            autoFocus
          />
          <input
            className={cx(styles.input, styles.inputName)}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="display name"
            aria-label="Project display name"
            data-testid="project-name-input"
          />
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.unmark}
              disabled={busy}
              onClick={() => void save()}
              data-testid="project-rename-save"
            >
              Save
            </button>
            <button
              type="button"
              className={styles.unmark}
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <li className={styles.row}>
      <span className={styles.handle}>{project.handle}</span>
      <span className={styles.path}>{project.path}</span>
      {project.aliases?.length ? (
        <span className={styles.aliases} title="Old handles that still resolve">
          ← {project.aliases.join(', ')}
        </span>
      ) : null}
      {canManage && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.unmark}
            disabled={busy}
            onClick={startEdit}
            data-testid="project-rename"
          >
            Rename
          </button>
          <button
            type="button"
            className={styles.unmark}
            disabled={busy}
            onClick={() => void remove()}
          >
            Unmark
          </button>
        </div>
      )}
    </li>
  )
}
