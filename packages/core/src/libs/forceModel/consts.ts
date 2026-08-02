// Force-layout tuning constants for the ONE force model both layouts share. The
// client (ForceGraphCanvas) tunes its live d3 simulation with these numbers; the
// server-side layout pass (layout.ts) replays the exact same model when it
// pre-computes positions for the snapshot. If the two drift, the first drag after
// load "snaps" the map toward the client's idea of rest — so every constant lives
// here and only here.
//
// The numbers themselves were picked visually back when the model lived in
// ForceGraphCanvas (see each comment); tweak them here and both layouts follow.

/** Lets the hub push reach across a dense core without far clusters drifting
 *  to infinity. */
export const CHARGE_DISTANCE_MAX = 900

/** Resting edge length is radius-aware: a link rests at
 *  (rA + rB + LINK_GAP·spacing), so two connected nodes never sit closer than
 *  they physically can — edges never demand less room than collision needs.
 *  LINK_GAP is the edge-to-edge breathing room at spacing 1. */
export const LINK_GAP = 85
/** Soft-ish links so hubs don't reel neighbours back in. */
export const LINK_STRENGTH = 0.4
/** Edge-to-edge gap collision keeps at spacing 1 (scales with spacing). */
export const COLLIDE_PAD = 12
/** How hard nodes are pulled toward their group's slot on the anchor ring.
 *  High enough to form visible colour regions, low enough that links still
 *  shape them. */
export const CLUSTER_STRENGTH = 0.4

// Node sizing: the metric is normalised against the dataset max, then mapped
// into a fixed radius range, so the smallest and biggest nodes always span the
// same visual gamut. SIZE_GAMMA < 1 lifts the mid-range so differences read.
export const SIZE_MIN_R = 3
export const SIZE_MAX_R = 24
export const SIZE_GAMMA = 0.6
export const SIZE_UNIFORM_R = 6

/** The default view's effective spacing: the UI slider's 100% plus the +10%
 *  shift GraphView feeds into the force model (its SPACING_SHIFT). The server
 *  layout assumes this default; a user on a non-default spacing re-layouts
 *  client-side the moment they touch the slider, as always. */
export const DEFAULT_SPACING = 1.1

export const MIN_CLUSTER_GROUPS = 3

/** The client simulation's velocity decay (d3VelocityDecay). */
export const VELOCITY_DECAY = 0.28
