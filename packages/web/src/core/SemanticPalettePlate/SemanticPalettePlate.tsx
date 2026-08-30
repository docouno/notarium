import { FIELD_COLOR, type FieldColor } from '@notarium/contract/enums'
import { Button } from '../Button'
import { Chip } from '../Chips'
import { FacetChip } from '../FacetChip'
import { Notice } from '../Notice'
import { Select } from '../Select'
import styles from './SemanticPalettePlate.module.scss'

const tones = Object.values(FIELD_COLOR)

const ToneRow = ({ color }: { color: FieldColor }) => (
  <div className={styles.row} data-testid="semantic-tone" data-tone={color}>
    <strong>{color}</strong>
    <Chip color={color} testId="palette-chip">
      Chip
    </Chip>
    <FacetChip
      label="Facet"
      count={8}
      color={color}
      onClick={() => undefined}
      testId="palette-facet"
    />
    <Select
      value={color}
      options={[{ value: color, label: 'Select', color }]}
      onChange={() => undefined}
      appearance="quiet"
      aria-label={`${color} select`}
      data-testid="palette-select"
    />
    <Notice color={color} data-testid="palette-notice">
      Notice
    </Notice>
    <Button color={color} data-testid="palette-button">
      Button
    </Button>
  </div>
)

/** Test-harness plate for the shared semantic-tone contract. It is reachable only
 * when the existing E2E flag is armed; normal product navigation cannot expose it. */
export const SemanticPalettePlate = () => (
  <main className={styles.plate} data-testid="semantic-palette-plate">
    <h1>Semantic palette</h1>
    <Button variant="danger" data-testid="palette-danger-solid">
      Delete forever
    </Button>
    <span
      data-testid="palette-accent-solid"
      style={{ background: 'var(--accent)', color: 'var(--accent-on-solid)', padding: 8 }}
    >
      Selected date
    </span>
    {tones.map((color) => (
      <ToneRow key={color} color={color} />
    ))}
  </main>
)
