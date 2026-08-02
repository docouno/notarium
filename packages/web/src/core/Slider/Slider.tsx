import { type CSSProperties, type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './Slider.module.scss'

type SliderProps = {
  label?: ReactNode
  min?: number
  max?: number
  step?: number
  value: number
  onChange: (value: number) => void
  distribution?: number[] | null
  formatValue?: (value: number) => ReactNode
}

// Slider — a refined range control for the kit. Fully custom-styled (no native
// accent-color chrome): a thin track that fills the *kept* side, a compact thumb,
// and the value as a quiet pill.
//
// Optional `distribution` (per-bucket counts, bucket i ↔ value i) renders a faint
// histogram behind the track, turning the control into a threshold-over-data view:
// it's a *threshold* slider (keep ≥ value), not a *magnitude* one, so the histogram
// is the hero — buckets at/above the thumb read as KEPT (accent), below it as
// dropped (muted), and the thumb is the cut line. The plain fill line is suppressed
// in this mode (see .has-hist in CSS) so it doesn't compete with the bars. Drop the
// prop → it degrades to a clean magnitude slider whose accent fill grows with the
// value. Heights use a sqrt scale so a long tail (e.g. the few hubs in a graph)
// stays visible next to a tall zero bucket.
export const Slider = ({
  label,
  min = 0,
  max = 100,
  step = 1,
  value,
  onChange,
  distribution,
  formatValue = (v) => v,
}: SliderProps) => {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  const bars = distribution && distribution.length > 1 ? distribution : null
  const peak = bars ? Math.max(1, ...bars) : 1

  return (
    <div className={styles.slider}>
      {/* Headless when no label: the caller owns the heading (e.g. a panel section
          header), so the label inherits that context instead of a control style. */}
      {label && (
        <div className={styles.sliderHead}>
          <span className={styles.sliderLabel}>{label}</span>
          <span className={styles.sliderValue}>{formatValue(value)}</span>
        </div>
      )}
      <div
        className={cx(styles.sliderControl, bars && styles.hasHist)}
        style={{ '--pct': `${pct}%` } as CSSProperties}
      >
        {bars && (
          <div className={styles.sliderHist} aria-hidden="true">
            {bars.map((c, i) => (
              <span
                key={i}
                className={cx(styles.sliderBar, i < value && styles.cut)}
                style={{ height: c > 0 ? `${Math.max(8, Math.sqrt(c / peak) * 100)}%` : 0 }}
              />
            ))}
          </div>
        )}
        <input
          className={styles.sliderInput}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(+e.target.value)}
        />
      </div>
    </div>
  )
}
