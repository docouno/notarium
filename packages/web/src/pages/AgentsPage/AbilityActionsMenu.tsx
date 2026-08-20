import { useRef, useState } from 'react'
import type { AgentAbilitySummary } from '@notarium/contract'
import { Button } from '../../core/Button'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import {
  IconCheck,
  IconEdit,
  IconMore,
  IconPlus,
  IconScrollText,
  IconTrash,
  IconX,
} from '../../core/Icons'

export const AbilityActionsMenu = ({
  ability,
  busy,
  onEdit,
  configure,
  addVersion,
  onToggle,
  onDelete,
  onAdd,
  testId,
}: {
  ability: AgentAbilitySummary
  busy: boolean
  onEdit?: () => void
  configure?: { onClick: () => void; children?: MenuItem[] }
  /** Projects this Space base has no version in yet — the alternative to a copy.
   *  Creating something new is a one-shot action and belongs here; WHERE an ability
   *  belongs is a property of it and is edited, not picked from a menu. */
  addVersion?: MenuItem[]
  onToggle?: (enabled: boolean) => void
  onDelete?: () => void
  onAdd?: () => void
  testId: string
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const enabled = 'enabled' in ability && ability.enabled
  const items: MenuItem[] = [
    ...(onEdit
      ? [
          {
            label: 'Edit',
            icon: <IconEdit size={15} />,
            onClick: onEdit,
          },
        ]
      : []),
    ...(configure
      ? [
          {
            label: 'Configure context',
            icon: <IconScrollText size={15} />,
            ...(configure.children?.length
              ? { children: configure.children }
              : { onClick: configure.onClick }),
          },
        ]
      : []),
    ...(addVersion?.length
      ? [
          {
            label: 'Add version',
            icon: <IconPlus size={15} />,
            children: addVersion,
          },
        ]
      : []),
    ...(onToggle
      ? [
          {
            label: enabled ? 'Disable' : 'Enable',
            icon: enabled ? <IconX size={15} /> : <IconCheck size={15} />,
            onClick: () => onToggle(!enabled),
          },
        ]
      : []),
    ...(onAdd
      ? [
          {
            label: 'Add',
            icon: <IconPlus size={15} />,
            onClick: onAdd,
          },
        ]
      : []),
    ...(onDelete
      ? [
          ...(onEdit || configure || addVersion?.length || onToggle || onAdd
            ? [{ divider: true } as MenuItem]
            : []),
          {
            label: 'Delete',
            icon: <IconTrash size={15} />,
            danger: true,
            onClick: onDelete,
          },
        ]
      : []),
  ]

  if (!items.length) {
    return null
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        icon
        variant="ghost"
        active={menuAt != null}
        disabled={busy}
        aria-label={`More actions for ${ability.title}`}
        data-testid={testId}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const rect = triggerRef.current?.getBoundingClientRect()

          if (rect) {
            setMenuAt({ x: rect.right, y: rect.bottom + 4 })
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <IconMore size={16} />
      </Button>
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={items}
          onClose={() => setMenuAt(null)}
          ignoreRef={triggerRef}
        />
      )}
    </>
  )
}
