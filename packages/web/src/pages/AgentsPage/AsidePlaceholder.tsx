import { AsidePanel, AsideValue } from '../../core/AsidePanel'
import { Skeleton } from '../../core/Skeleton'

/** What a routed Agents panel shows while its subject is missing (#393). The aside
 *  belongs to the ROUTE, not to the answer: it stays mounted through loading and through
 *  failure, so the content column keeps its width and the toggle keeps its place, and
 *  what changes is only what the panel says. One component for all of them on purpose —
 *  three neighbouring routes each inventing a placeholder is the very custom this
 *  surface is being rid of.
 *
 *  The one place in the section where a panel body is not a column of labelled fields,
 *  and deliberately: there is no subject to label yet, and a caption over nothing is the
 *  thing `AsideField` exists to prevent. */
export const AsidePlaceholder = (props: { loading: true } | { loading: false; blank: string }) => (
  <AsidePanel testId="aside-placeholder">
    {props.loading ? (
      // Two lines, the shape of a field and its value: the panel reserves its own box the
      // way every skeleton in the section does.
      <>
        <Skeleton w="70%" h={13} />
        <Skeleton w="45%" h={13} />
      </>
    ) : (
      <AsideValue>{props.blank}</AsideValue>
    )}
  </AsidePanel>
)
