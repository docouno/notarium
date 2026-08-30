export const FIELD_SCHEMA_STATUS = {
  ready: 'ready',
  futureVersion: 'future-version',
  formError: 'form-error',
  structuralError: 'structural-error',
  unavailable: 'unavailable',
} as const

export type FieldSchemaStatus = (typeof FIELD_SCHEMA_STATUS)[keyof typeof FIELD_SCHEMA_STATUS]
