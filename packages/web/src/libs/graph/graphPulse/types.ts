// A scientific-pitch note name ("C4", "G#5").
export type NoteName = string

// One lead event: a note (null = a rest) and its length in beats.
export type ScoreNote = [NoteName | null, number]

// The synth bench every instrument plays into: the audio context plus the buses
// built once when the mode opens. `noise` hands out the shared white-noise buffer
// (built lazily — it's ~0.3s of random samples). Lives here rather than beside the
// instruments because the bus factory, the arrangement and the engine all speak it.
export type PulseBus = {
  ctx: AudioContext
  // Tonal bus — rounded off by a low-pass and fed into the echo.
  master: GainNode
  // Percussion bus — bypasses the low-pass, so kicks/hats stay crisp.
  perc: GainNode
  // The single node everything lands on before the speakers; fading THIS fades the
  // whole mix (percussion included) on the way out.
  out: GainNode
  // Shared vibrato, connected to every tonal oscillator's detune.
  lfoDepth: GainNode
  noise: () => AudioBuffer
}

// One bar of the score: the lead line plus the bass/chord root under it.
export type ScoreBar = { lead: readonly ScoreNote[]; root: NoteName }

// The rhythm-section arrangement a segment is played with.
export type PulseStyle = 'band' | 'lofi' | 'trap'

// One segment of the medley: the same score in its own key and arrangement.
// `intro` marks the segment that opens with a bare-lead pass (first cycle only).
export type PulseSegment = { style: PulseStyle; bpm: number; semis: number; intro: boolean }

// The graph slice the pulse plays over: only what the walk and the lighting need,
// so the engine stays independent of the canvas's hydrated node shape. The walk
// itself reads id + degree; ghost/filePath are there because the caller's
// grouping function (the canvas's own) is handed these nodes.
export type PulseNode = { id: string; degree?: number; ghost?: boolean; filePath?: string | null }
export type PulseLink = { source: string | { id: string }; target: string | { id: string } }
// Generic in the node so a caller can hand over its own richer nodes and keep a
// grouping function typed against them (the canvas's, which reads more than the
// pulse does).
export type PulseGraph<N extends PulseNode = PulseNode> = {
  nodes: readonly N[]
  links: readonly PulseLink[]
}

export type PulseOptions<N extends PulseNode = PulseNode> = {
  // Called when the mode ends, so the view can drop its reference to the engine.
  onEnd?: () => void
  // Node → colour-group key, mirroring the canvas grouping: a strike lights a few
  // members of the same group, which (the layout clusters groups) glow together.
  groupOf?: (node: N) => string | null
}

// All the renderer needs from a running pulse: whether it's on, whether motion is
// dialled down, and how hot each node is this frame. Keeps the canvas off the
// engine's full surface (and lets it hold the lazily-imported module by type).
export type PulseGlow = {
  active: boolean
  reduced: boolean
  intensityFor: (id: string) => number
}

// A held piano voice: the oscillator and the gain its release fades.
export type PulseVoice = { osc: OscillatorNode; gain: GainNode }

// A strike waiting for its moment on the audio clock.
export type PendingStrike = { at: number; nodeId: string | undefined; cluster: boolean }
