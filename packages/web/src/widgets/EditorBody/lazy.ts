import { useCallback, useLayoutEffect, useRef } from 'react'

export const useLazyEditorAutoFocus = (active: boolean, editorKey: number) => {
  const focusOrigin = useRef<Element | null>(null)

  // `isEditing` can stay true across draft A→B. The keyed EditorBody remount is a
  // fresh focus decision too, so capture the control that initiated that draft.
  useLayoutEffect(() => {
    focusOrigin.current = active ? document.activeElement : null
  }, [active, editorKey])

  return useCallback(() => {
    const current = document.activeElement

    return current == null || current === document.body || current === focusOrigin.current
  }, [])
}

export const loadEditorBody = async () => {
  const { EditorBody } = await import('./EditorBody')
  return { default: EditorBody }
}
