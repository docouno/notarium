// Class-visibility policy matrix — the per-class capability table and its
// derivations. Depends on the ClassPolicy shape (types) and the note-class vocabulary
// (knowledgeStore); lives OUT of the pure consts sink so consts.ts imports nothing.

import { NOTE_CLASS } from '../knowledgeStore'
import type { NoteClass } from '../knowledgeStore'
import type { ClassPolicy } from './types'

/** The class registry v1 with its policy matrix. The notes-index scans `.md`, so
 *  user-doc, agent-memory, profile, and Markdown skill members can produce rows;
 *  `attachment` (non-md files) and `derived` (regenerable, app-data)
 *  carry their policies here for forward-compat and for surfaces that reason
 *  about them, but do not appear as note rows in v1 (conscious boundary). */
export const CLASS_POLICY: Record<NoteClass, ClassPolicy> = {
  [NOTE_CLASS.userDoc]: {
    index: true,
    graph: true,
    feed: true,
    tree: true,
    userSearch: true,
    agentRecall: true,
    versioned: true,
    replicate: true,
    providerEgress: true,
  },
  [NOTE_CLASS.attachment]: {
    index: false,
    graph: false,
    feed: false,
    tree: true,
    userSearch: true,
    agentRecall: false,
    versioned: true,
    replicate: true,
    providerEgress: false,
  },
  [NOTE_CLASS.derived]: {
    index: false,
    graph: false,
    feed: false,
    tree: false,
    userSearch: false,
    agentRecall: false,
    versioned: false,
    replicate: false,
    providerEgress: false,
  },
  [NOTE_CLASS.agentMemory]: {
    // Indexed (recall needs it) and versioned/replicated as truth, but hidden
    // from every default user surface — visible to the user only through the
    // dedicated memory section, never the Feed/tree/search/graph.
    index: true,
    graph: false,
    feed: false,
    tree: false,
    userSearch: false,
    agentRecall: true,
    versioned: true,
    replicate: true,
    providerEgress: true,
  },
  [NOTE_CLASS.profile]: {
    // The reserved personal-profile note: HUMAN-authored "about me",
    // surfaced through the Settings → Profile tab and loaded into the agent's
    // start_session — and NOWHERE else. Hidden from EVERY discovery surface:
    // tree/graph/feed (the clutter it fixes), userSearch (the user reaches it
    // from Settings, not by searching their notes), and agentRecall (the agent
    // gets it eagerly at session start, not as generic recall noise). Still
    // index:true — the engine physically indexes the .md regardless; the read-
    // model filters it out of search by userSearch:false (like agent-memory).
    // Versioned + replicated like any user truth. Found by the personal layer
    // via an explicit `all`-scope read (invisible to every discovery scope by
    // design — see personalContent.findProfileNote / gateway.buildProfile).
    index: true,
    graph: false,
    feed: false,
    tree: false,
    userSearch: false,
    agentRecall: false,
    versioned: true,
    replicate: true,
    providerEgress: true,
  },
  [NOTE_CLASS.skill]: {
    // Installed Agent Skills are file truth in the hidden skills mount. They are
    // deliberately absent from every generic discovery surface: the dedicated
    // Agents section and role service are the only catalog/library readers.
    // These note policies apply to scanned Markdown members. Auxiliary package
    // bytes stay outside the note journal but ride the package-aware all-scope
    // export and data backup verbatim.
    index: true,
    graph: false,
    feed: false,
    tree: false,
    userSearch: false,
    agentRecall: false,
    versioned: true,
    replicate: true,
    providerEgress: true,
  },
}

/** Every class in the registry — iteration/validation order is registry order. */
export const NOTE_CLASSES = Object.keys(CLASS_POLICY) as NoteClass[]

/** A note with no stamped class is an ordinary user document (defensive default
 *  for bare-engine rows; the materialized stack always stamps a class). */
export const DEFAULT_NOTE_CLASS: NoteClass = NOTE_CLASS.userDoc
