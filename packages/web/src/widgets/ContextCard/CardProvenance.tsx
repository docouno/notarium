import type { Author } from '@notarium/contract'
import { IconBotMessage, IconClock, IconUser } from '../../core/Icons'
import { authorLabel } from '../../libs/author'
import { absoluteDate } from '../../libs/datetime'
import styles from './ContextCard.module.scss'

// The #12 provenance line for a note card — who recorded/edited it and when. The
// tooltip is the resolved author label, NEVER the raw principal (#13). Shared by
// the Memory audit and the Context constructor.
export const CardProvenance = ({
  author,
  modifiedAt,
}: {
  author: Author | null
  modifiedAt: string | null
}) => {
  const who = authorLabel(author)
  return (
    <span className={styles.prov} title={who.text}>
      {who.agent ? <IconBotMessage size={12} /> : <IconUser size={12} />}
      <span>Recorded by {who.text}</span>
      {modifiedAt && (
        <>
          <span className={styles.dot}>·</span>
          <IconClock size={11} />
          <span>{absoluteDate(modifiedAt)}</span>
        </>
      )}
    </span>
  )
}
