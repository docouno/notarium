import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useChrome } from '../../composers/ChromeProvider'
import { AsideGroups, type AsidePanelDef, type LayoutSpec } from '../../core/AsideGroups'
import { IconPanelRight } from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { TopbarActionSeparator } from '../../layouts/PageFrame'
import { useAgentsShell } from './AgentsProvider'

/** The one right-panel adapter for routed Agents surfaces. Domain pages supply
 * panels; this component supplies the persisted global state, toggle placement,
 * shared AsideGroups shell and narrow focus/inert behavior. */
export const AgentsPanel = ({
  panels,
  defaultLayout,
  storageKey = null,
  label,
  modalLabel = label,
}: {
  panels: AsidePanelDef[]
  defaultLayout: LayoutSpec
  storageKey?: string | null
  label: string
  modalLabel?: string
}) => {
  const { asideOpen, toggleAside, narrowLayout: narrow } = useChrome()
  const { toggleHost, asideHost, setContentInert } = useAgentsShell()
  const previousAsideOpen = useRef(asideOpen)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const focusAsideOnOpen = asideOpen && !previousAsideOpen.current

  useEffect(() => {
    previousAsideOpen.current = asideOpen
  }, [asideOpen])

  useEffect(() => {
    setContentInert(asideOpen && narrow)
    return () => setContentInert(false)
  }, [asideOpen, narrow, setContentInert])

  const setOpener = useCallback((node: HTMLButtonElement | null) => {
    openerRef.current = node
  }, [])

  useEffect(() => {
    if (asideOpen || !restoreFocus.current) {
      return
    }
    const frame = requestAnimationFrame(() => {
      restoreFocus.current = false
      openerRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [asideOpen])

  const close = useCallback(() => {
    // On narrow screens the trigger lives inside the inert PageFrame. Clear inert
    // before the trigger is remounted, otherwise the browser correctly refuses
    // the focus restoration attempted on the next animation frame.
    if (narrow) {
      setContentInert(false)
    }
    restoreFocus.current = true
    toggleAside()
  }, [narrow, setContentInert, toggleAside])

  // A guard, not a state any route SHOWING SECTION CONTENT reaches: since #393 those
  // mount one panel in every state they have, so an empty array here means a caller built
  // its panels from data instead of from the route. The section's 404 and its redirect
  // routes mount no panel at all — they render inside the shell without being a surface.
  if (!panels.length) {
    return null
  }

  const openToggle = (
    <>
      <TopbarActionSeparator />
      <IconToggle
        ref={setOpener}
        icon={<IconPanelRight size={15} />}
        active={false}
        onClick={toggleAside}
        title={`Open ${label}`}
      />
    </>
  )
  const closeToggle = (
    <IconToggle
      icon={<IconPanelRight size={15} />}
      active
      onClick={close}
      title={`Close ${label}`}
    />
  )
  const aside = asideOpen ? (
    <AsideGroups
      panels={panels}
      defaultLayout={defaultLayout}
      storageKey={storageKey}
      headerAction={closeToggle}
      overlayOnNarrow
      modal={narrow}
      modalLabel={modalLabel}
      onRequestClose={close}
      autoFocus={focusAsideOnOpen || narrow}
    />
  ) : null

  return (
    <>
      {!asideOpen && toggleHost ? createPortal(openToggle, toggleHost) : null}
      {aside && asideHost ? createPortal(aside, asideHost) : null}
    </>
  )
}
