export type Heading = { level: number; text: string; line: number }

export type SectionResult =
  | { ok: true; body: string }
  /** No heading matched — the headings actually present (for a guiding error). */
  | { ok: false; headings: string[] }
