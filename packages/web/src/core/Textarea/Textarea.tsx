import { type TextareaHTMLAttributes } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './Textarea.module.scss'

// The multi-line text control: one skin for every textarea, rest-first so a caller
// cannot clobber the class merge.
// canon: docs/web-ui.md#styles-modules-a-thin-global-layer
export const Textarea = ({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...rest} className={cx(styles.textarea, className)} />
)
