import { Skeleton } from '../../core/Skeleton'
import styles from './Board.module.scss'

export const BoardCardSkeleton = () => (
  <div className={styles.cardSkeleton} data-testid="board-column-skeleton" aria-hidden="true">
    <div className={styles.cardHead}>
      <Skeleton className={styles.cardTitleSkeleton} />
    </div>
    <div className={styles.cardFields}>
      <Skeleton className={styles.cardChipSkeleton} />
      <Skeleton className={styles.cardChipSkeletonWide} />
      <Skeleton className={styles.cardChipSkeleton} />
    </div>
  </div>
)

export const BoardLoadingSkeleton = () => (
  <div className={styles.board} data-testid="board-loading-skeleton" aria-hidden="true">
    <div className={styles.scroller}>
      {Array.from({ length: 3 }, (_, index) => (
        <section key={index} className={styles.column}>
          <header className={styles.columnHead}>
            <Skeleton className={styles.columnTitleSkeleton} />
            <Skeleton className={styles.columnCountSkeleton} />
          </header>
          <div className={styles.cards}>
            <BoardCardSkeleton />
            {index === 0 ? <BoardCardSkeleton /> : null}
          </div>
        </section>
      ))}
    </div>
  </div>
)
