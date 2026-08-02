export type Kind =
  '' | 'blank' | 'quote' | 'code' | 'list' | 'hr' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

export type Run = { cls: string; from: number; to: number } // doc positions (line starts)
