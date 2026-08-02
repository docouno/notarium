// Semantic operations catalog: agent-gateway intents composing MORE than one
// KnowledgeStore call (recall, edit_note, link, memory-append) — core helpers over
// the port (D-placement) so every engine inherits them; the gateway resolves the
// store + runs authz before calling in. canon: docs/note-model.md#agent-memory
export * from './editNote'
export * from './link'
export * from './recall'
export * from './memory'
