import { useMemo } from 'react'
import { Button } from '../../core/Button'
import { IconWorkspace } from '../../core/Icons'
import { StateView } from '../../core/StateView'
import { useAuth } from '../AuthProvider'
import { useSpace } from '../SpaceProvider'
import styles from './SpaceAccess.module.scss'

// The takeover face for "the active space is gone" (#111). Confirmed loss only —
// the data providers below it have already unmounted (its content can't linger),
// so this owns the viewport. One screen for revoke / archive / delete: the user
// can't act on the cause, only on where to go next. `target` is the space to
// land in (personal first, #99), or null when nothing's left.

export const SpaceLostScreen = ({ target }: { target: string | null }) => {
  const { spaces, personalSpace, switchSpace } = useSpace()
  const { logout } = useAuth()

  const targetName = useMemo(() => {
    if (!target) {
      return null
    }
    if (personalSpace?.slug === target) {
      return personalSpace.displayName
    }

    return spaces.find((s) => s.slug === target)?.displayName ?? target
  }, [target, spaces, personalSpace])

  return (
    <div className={styles.takeover}>
      {target ? (
        <StateView
          tone="muted"
          code="Access ended"
          icon={<IconWorkspace size={30} />}
          title="You no longer have access to this space"
          description="Your membership was removed, or the space was archived or deleted. Anything unsaved here couldn’t be kept — your other spaces are unaffected."
          testId="space-access-lost"
          actions={
            <Button variant="primary" onClick={() => switchSpace(target)}>
              {`Switch to ${targetName}`}
            </Button>
          }
        />
      ) : (
        <StateView
          tone="muted"
          code="No access"
          icon={<IconWorkspace size={30} />}
          title="No spaces available"
          description="You don’t have access to any spaces right now. Ask an admin to add you to one."
          testId="space-access-none"
          actions={
            <Button variant="primary" onClick={() => void logout()}>
              Sign out
            </Button>
          }
        />
      )}
    </div>
  )
}
