import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { ParsedViewBlock } from '@notarium/core'

import { ErrorBoundary } from '../ErrorBoundary'

type ViewHost = {
  block: ParsedViewBlock
  element: HTMLElement
}

type MarkdownDocumentProps = Omit<HTMLAttributes<HTMLDivElement>, 'dangerouslySetInnerHTML'> & {
  html: string
  viewBlocks?: readonly ParsedViewBlock[]
  renderViewBlock?: (block: ParsedViewBlock) => ReactNode
  rootRef?: RefObject<HTMLDivElement>
}

const ViewPortals = ({
  root,
  html,
  blocks,
  render,
}: {
  root: RefObject<HTMLDivElement>
  html: string
  blocks: readonly ParsedViewBlock[]
  render: (block: ParsedViewBlock) => ReactNode
}) => {
  const [hosts, setHosts] = useState<ViewHost[]>([])

  useLayoutEffect(() => {
    const element = root.current

    if (!element) {
      setHosts([])
      return
    }
    const byOccurrence = new Map(blocks.map((block) => [String(block.occurrence), block]))
    const next: ViewHost[] = []

    element.querySelectorAll<HTMLElement>('[data-notarium-view-block]').forEach((placeholder) => {
      const occurrence = placeholder.dataset.notariumViewBlock
      const block = occurrence == null ? undefined : byOccurrence.get(occurrence)

      if (block) {
        next.push({ block, element: placeholder })
      }
    })
    setHosts(next)

    return () => setHosts([])
  }, [blocks, html, root])

  return hosts.map(({ block, element }) =>
    createPortal(
      <ErrorBoundary resetKey={`${block.occurrence}:${block.payload}`}>
        {render(block)}
      </ErrorBoundary>,
      element,
      String(block.occurrence),
    ),
  )
}

/** One React-owned Markdown container. View blocks are portals into inert hosts,
 * so they keep every provider and unmount with this tree without a second root. */
export const MarkdownDocument = ({
  html,
  viewBlocks = [],
  renderViewBlock,
  rootRef,
  className,
  ...rest
}: MarkdownDocumentProps) => {
  const ownRef = useRef<HTMLDivElement>(null)
  const ref = rootRef ?? ownRef

  return (
    <>
      <div {...rest} ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />
      {renderViewBlock && viewBlocks.length > 0 ? (
        <ViewPortals root={ref} html={html} blocks={viewBlocks} render={renderViewBlock} />
      ) : null}
    </>
  )
}
