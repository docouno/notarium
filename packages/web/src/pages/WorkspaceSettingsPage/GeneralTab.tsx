import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { asciiSlug } from '@notarium/core/slug'
import { useAuth } from '../../composers/AuthProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { SettingsSection } from '../../core/SettingsSection'
import { useToast } from '../../core/Toast'
import { canManageSpace } from '../../libs/access'
import { cx } from '../../libs/cx/cx'
import { errorText } from '../../libs/errors'
import { workspaceSettingsRoute } from '../../libs/routing/routePaths'
import styles from './GeneralTab.module.scss'

// The URL handle accepts only the slug alphabet, typed directly: lowercase Latin
// letters, digits and dashes. Rather than silently transliterating other input
// (a Cyrillic name belongs in the display name, not the handle), we REJECT anything
// outside the alphabet on the fly — uppercase is folded to lowercase (still Latin),
// everything else (spaces, Cyrillic, punctuation) is dropped — and gently flag that a
// character was skipped so the user sees why their keystroke "did nothing". The hint is
// informational, never a red error.
const filterHandle = (raw: string): { value: string; dropped: boolean } => {
  const value = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  // A drop happened if anything other than a case fold was removed (length shrank).
  return { value, dropped: value.length < raw.length }
}

// General (#100 phase 4 / #123): the space's own identity — its URL handle (slug) and
// display name. Renaming is link-safe: a changed slug retires the old one into the
// alias history server-side (id-keyed child tables are untouched), so bookmarked
// `/s/<old-slug>` URLs keep resolving and redirect. An owner-need management act
// (canManageSpace), so a writer/reader never reaches this tab. The personal domain
// is excluded — its handle is an internal detail and its name is the fixed "Personal"
// (renaming it has no user-facing meaning), so a stray deep-link bounces to Projects.
export const GeneralTab = () => {
  const { space, spaces, personalSpace, renameSpace, archiveSpace, capabilities } = useSpace()
  const { mode, me } = useAuth()
  const toast = useToast()
  const { confirm } = useDialog()
  const active = spaces.find((s) => s.slug === space)
  const activeSlug = active?.slug
  const activeName = active?.displayName

  const [slug, setSlug] = useState(activeSlug ?? space)
  const [name, setName] = useState(activeName ?? '')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // True when the last handle keystroke was rejected (a space/Cyrillic/punctuation
  // char dropped) — drives the gentle "Latin only" hint, cleared by the next accepted
  // keystroke. Not an error state; just an explanation for the skipped character.
  const [handleBlocked, setHandleBlocked] = useState(false)

  // Re-seed when the active record changes under us: after our own rename
  // canonicalises the URL (slug param flips), or another tab renamed it (the `rename`
  // SSE nudge re-fetches the list). Fires only on a committed change, never mid-typing
  // (the active record is stable until a server round-trip lands), so it can't clobber
  // an in-progress edit.
  useEffect(() => {
    if (activeSlug !== undefined && activeName !== undefined) {
      setSlug(activeSlug)
      setName(activeName)
      setHandleBlocked(false)
    }
  }, [activeSlug, activeName])

  const onHandleChange = (raw: string) => {
    const { value, dropped } = filterHandle(raw)
    setSlug(value)
    setHandleBlocked(dropped)
  }

  // The personal domain has no rename surface — bounce a deep-link to Projects (the
  // one management tab it does have), matching the Members tab's personal bounce.
  if (personalSpace?.slug === space) {
    return <Navigate to={workspaceSettingsRoute(space, 'projects')} replace />
  }
  // Self-guard so Management's default landing (the index → general redirect) is safe
  // for everyone: only a manager (space:manage) on a host that actually keeps a space
  // registry to rename in (capabilities.spaceCreate) gets the form — exactly the gate
  // WorkspaceSettingsPage uses to list the tab. Anyone else lands on the member list
  // they can see, not a form the server would reject.
  if (!capabilities.spaceCreate || !canManageSpace(me, mode, space)) {
    return <Navigate to={workspaceSettingsRoute(space, 'members')} replace />
  }
  if (!active) {
    // Archive may remove the active row via its access nudge before the data-router's
    // lazy fallback navigation has loaded its destination. Keep this outgoing branch
    // inert while deleting so its self-guard cannot redirect back into the deleted space.
    if (deleting) {
      return null
    }

    return <Navigate to={workspaceSettingsRoute(space, 'members')} replace />
  }

  // The canonical handle = the field run through asciiSlug once more (drops any trailing
  // dash kept for typing). This is what we compare, preview and send.
  const handleSlug = asciiSlug(slug)
  const trimmedName = name.trim()
  const dirty = handleSlug !== active.slug || trimmedName !== active.displayName
  const canSave = !busy && dirty && handleSlug.length > 0 && trimmedName.length > 0

  // Delete = move the whole space to the Trash (#110): the same safety net as a deleted
  // note (#79), one space up — restorable with all its content and history, gone for
  // good only on a permanent delete from the Trash. While in the Trash it stops being
  // served and disappears for other members. archiveSpace then leaves this tab for the
  // Trash of a readable fallback (it can't stay in a space it just deleted), so the user
  // sees exactly where it went.
  const onDelete = async () => {
    if (!active) {
      return
    }
    const ok = await confirm({
      title: `Delete “${active.displayName}”?`,
      message: (
        <>
          The whole space moves to the <b>Trash</b> — you can restore it any time with all its notes
          and history. While in the Trash it stops being served and disappears for other members;
          it’s gone for good only if you permanently delete it from the Trash.
        </>
      ),
      confirmLabel: 'Move to Trash',
      cancelLabel: 'Cancel',
      danger: true,
    })

    if (!ok) {
      return
    }
    setDeleting(true)
    const spaceDisplayName = active.displayName

    try {
      await archiveSpace(active.slug)
      // archiveSpace navigates this tab to a readable fallback; the toast (app-level,
      // survives the route change) tells the user where the space went.
      toast.success(`“${spaceDisplayName}” moved to Trash — restore it from Trash → Spaces`)
    } catch (e) {
      toast.error(errorText(e))
      setDeleting(false)
    }
  }

  const onSave = async () => {
    if (!canSave) {
      return
    }
    const patch: { slug?: string; displayName?: string } = {}

    if (handleSlug && handleSlug !== active.slug) {
      patch.slug = handleSlug
    }
    if (trimmedName && trimmedName !== active.displayName) {
      patch.displayName = trimmedName
    }
    setBusy(true)
    try {
      await renameSpace(patch)
      // The slug change canonicalises the URL (SpaceProvider) and re-seeds the form
      // via the effect above; nothing else to reset here.
      toast.success('Workspace updated')
    } catch (e) {
      // 409 (slug already in use) / 400 (slug pinned by host config) / network — the
      // server's message is the actionable part.
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsSection
        title="General"
        testId="space-general"
        description="Your workspace's display name and its URL handle. Renaming is link-safe — old links keep resolving."
      >
        <div className={styles.form}>
          {/* Two short fields sit side by side on a wide panel and wrap to a stack on a
            narrow one (the inputs share a row; hints fall below). */}
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.label}>Display name</span>
              <input
                className={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                maxLength={200}
                aria-label="Workspace display name"
                data-testid="space-display-name"
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>URL handle</span>
              <input
                className={cx(styles.input, styles.inputSlug)}
                value={slug}
                onChange={(e) => onHandleChange(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Workspace URL handle"
                data-testid="space-slug"
              />
              <span
                className={cx(styles.hint, handleBlocked && styles.hintBlocked)}
                data-testid="space-slug-hint"
              >
                {handleBlocked ? (
                  <>
                    Only Latin letters, digits, dashes and underscores — other characters are
                    skipped.
                  </>
                ) : (
                  <>
                    Appears as <code>/s/{handleSlug || active.slug}</code>. Latin letters, digits,
                    dashes and underscores.
                  </>
                )}
              </span>
              {active.aliases?.length ? (
                <span className={styles.aliases} title="Old handles that still resolve">
                  Old handles still resolve: {active.aliases.join(', ')}
                </span>
              ) : null}
            </label>
          </div>

          <div className={styles.formActions}>
            <Button
              variant="primary"
              onClick={() => void onSave()}
              disabled={!canSave}
              data-testid="space-rename-save"
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </SettingsSection>

      {/* Danger zone (#110): move the space to the Trash — the same safety net as a
        deleted note (#79), one level up. Restore + permanent delete live in the Trash
        (Spaces tab). Owner-gated by the tab itself (a non-manager never reaches it). */}
      <SettingsSection
        title="Danger zone"
        testId="space-danger"
        description="Delete this space. It moves to the Trash — restorable any time from Trash → Spaces — and stops being served for everyone until you restore it."
      >
        <div className={styles.dangerActions}>
          <Button
            variant="danger"
            onClick={() => void onDelete()}
            disabled={deleting}
            data-testid="space-delete"
          >
            {deleting ? 'Deleting…' : 'Delete this space'}
          </Button>
        </div>
      </SettingsSection>
    </>
  )
}
