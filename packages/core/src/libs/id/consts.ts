export const NOTE_ID_LENGTH = 12

/** The frontmatter key the id is materialized under. Namespaced on purpose:
 *  a bare `id` would collide with other tools' frontmatter (Dendron, exports). */
export const NOTE_ID_FRONTMATTER_KEY = 'notarium-id'
