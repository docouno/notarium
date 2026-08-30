import { Button } from '../../core/Button'
import { IconRefresh } from '../../core/Icons'
import { Notice } from '../../core/Notice'

export const FieldSchemaWarning = ({
  error,
  onRetry,
  message = 'Field presentation could not be loaded',
}: {
  error: string | null
  onRetry?: () => void
  message?: string
}) =>
  error ? (
    <Notice variant="warning" data-testid="field-schema-warning">
      {message}: {error}{' '}
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          <IconRefresh size={14} /> Retry
        </Button>
      )}
    </Notice>
  ) : null
