import {
  BEATS_PER_BAR,
  GLOW_TAU,
  KEYMAP,
  KOROBEINIKI,
  MEDLEY,
  REDUCED_GLOW_TAU,
  REQUEUE_LEAD_SEC,
  REQUEUE_POLL_MS,
  RISER_SEC,
} from './consts'
import { groove } from './helpers/arrangement'
import { closeBus, createBus, duckOut } from './helpers/audioBus'
import { releaseVoice, riser, startVoice, voice } from './helpers/instruments'
import { midiOf, transpose } from './helpers/pitch'
import { type Adjacency, buildAdjacency, buildPath } from './helpers/walk'
import type {
  PendingStrike,
  PulseBus,
  PulseGraph,
  PulseNode,
  PulseOptions,
  PulseSegment,
  PulseVoice,
} from './types'

// The graph plays itself: a looping medley walks the light along real edges in
// time with the tune, and the letter keys become a piano whose notes light nodes
// of their own. A quiet corner of the graph page for whoever finds it.
//
// Everything is SYNTHESISED with the Web Audio API — no audio file ships in the
// repo. The module is imported lazily on the trigger, so it costs the everyday
// bundle and the normal graph render nothing.
//
// The canvas reads `active` / `reduced` / `intensityFor()` every frame off this
// object, so the per-frame state lives here rather than in React state (which
// would re-render the whole view at audio rate).
class GraphPulse {
  // Whether the mode is on — the canvas's gate for its glow pass.
  active = false
  // Honours prefers-reduced-motion: the bloom is dropped and the glow decay is
  // stretched (see intensityFor), so the field breathes instead of strobing. Kept
  // in sync while the mode runs — the setting can change under us.
  reduced = false

  private bus: PulseBus | null = null
  private nodes: readonly PulseNode[] = []
  private adj: Adjacency = new Map()
  private byId = new Map<string, PulseNode>()
  // Node → colour-group key, mirroring the canvas grouping.
  private groupOf: ((node: PulseNode) => string | null) | null = null
  // Group key → member ids, so a strike can light a few same-colour nodes.
  private groupMembers = new Map<string, string[]>()
  // Piano pitch → a fixed node, so a key always lights the same one.
  private keyNode = new Map<string, string | undefined>()
  // Physical key code → its sustaining voices, while the key is held.
  private held = new Map<string, PulseVoice[]>()
  // Piano octave shift (Z/X), in octaves.
  private octave = 0
  // Node id → the audio time of its most recent strike.
  private hits = new Map<string, number>()
  // Scheduled future strikes, sorted by time.
  private pending: PendingStrike[] = []
  // Oscillators of the tune, so it can be cut off cleanly. Two generations, because
  // the next cycle is queued while the current one is still sounding: `melodyVoices`
  // is the cycle being queued, `tailVoices` the one still playing out. Dropping the
  // tail on re-queue (as this did) loses the only handle on a couple of seconds of
  // music — which then can't be stopped when the melody is toggled off.
  private melodyVoices: AudioScheduledSourceNode[] = []
  private tailVoices: AudioScheduledSourceNode[] = []
  // The running medley: its segments and when the current cycle ends.
  private medley: { segments: readonly PulseSegment[]; nextAt: number } | null = null
  private raf = 0
  // Re-queueing the next cycle runs off a timer, NOT off the animation frame: a
  // backgrounded tab freezes rAF, and the tune would run out mid-loop and never
  // come back. Timers are only throttled there (~1s), which the lookahead absorbs.
  private requeue: ReturnType<typeof setInterval> | null = null
  private motion: MediaQueryList | null = null
  private onMotion = (e: MediaQueryListEvent) => {
    this.reduced = e.matches
  }
  private onEnd: (() => void) | null = null

  // Enter the mode and start the looping medley. Returns whether it actually
  // started: the caller hands the keyboard over on the strength of this answer, so
  // a silent refusal (empty graph, no Web Audio, already running) MUST be
  // reportable — otherwise the caller stands its shortcuts down for a mode that
  // never came up, and nothing ever stands them back up.
  start<N extends PulseNode>(graph: PulseGraph<N>, opts: PulseOptions<N> = {}): boolean {
    if (!this.open(graph, opts)) {
      return false
    }
    this.startMedley(MEDLEY)

    return true
  }

  // Build the audio chain, the adjacency and the key→node / colour-group maps,
  // then start the clock. Stays open (interactive) until stop(). Returns false if
  // it refused to open — see start().
  open<N extends PulseNode>(
    graph: PulseGraph<N>,
    { onEnd, groupOf }: PulseOptions<N> = {},
  ): boolean {
    if (this.active || !graph.nodes.length) {
      return false
    }
    this.motion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    this.reduced = this.motion?.matches ?? false
    this.motion?.addEventListener?.('change', this.onMotion)
    this.onEnd = onEnd ?? null
    this.nodes = graph.nodes
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]))
    // Colour-group buckets — a strike lights a few nodes from the same group,
    // which (since the layout clusters groups) glow together in one region. The
    // cast is the generic's seam: the nodes handed back to `groupOf` are exactly
    // the ones it came in with, which the erased element type can't express.
    this.groupOf = (groupOf as ((node: PulseNode) => string | null) | undefined) ?? null
    this.groupMembers = new Map()

    if (groupOf) {
      for (const n of graph.nodes) {
        const k = groupOf(n)

        if (k == null) {
          continue
        }

        if (!this.groupMembers.has(k)) {
          this.groupMembers.set(k, [])
        }
        this.groupMembers.get(k)!.push(n.id)
      }
    }
    this.adj = buildAdjacency(graph.links)
    // Assign each piano pitch a fixed node — lowest note → biggest hub — so the
    // keyboard reads as a stable "instrument" laid over the graph.
    const ordered = [...graph.nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0))
    const pitches = Object.values(KEYMAP)
      .slice()
      .sort((a, b) => midiOf(a) - midiOf(b))
    this.keyNode.clear()
    pitches.forEach((p, i) => this.keyNode.set(p, ordered[i % ordered.length]?.id))
    this.hits.clear()
    this.pending = []
    this.melodyVoices = []
    this.tailVoices = []
    this.held.clear()
    this.octave = 0
    this.bus = createBus()

    if (!this.bus) {
      // No Web Audio here (or the context refused to build). Unwind everything this
      // call already put in place — the media-query subscription and the graph
      // slice — so a refusal leaves no trace behind. The callback goes with it:
      // nobody is going to call it, and a stale one would fire into the next
      // caller's session (start() reports the refusal instead).
      this.onEnd = null
      this.stop()

      return false
    }
    this.active = true
    this.loop()

    return true
  }

  // Stop/start the melody without leaving the mode (Space) — the piano stays live.
  toggleMelody(): void {
    if (!this.active) {
      return
    }

    if (this.medley) {
      this.stopMelody()
    } else {
      this.startMedley(MEDLEY)
    }
  }

  // Piano note-on: start a SUSTAINING voice for the physical key, transposed by
  // the current octave shift, and light its cluster. Returns whether the key is
  // mapped, so the caller knows whether to swallow the keystroke.
  noteOn(code: string): boolean {
    const bus = this.bus

    if (!this.active || !bus) {
      return false
    }
    const base = KEYMAP[code]

    if (!base) {
      return false
    }

    if (this.held.has(code)) {
      return true // already sounding — ignore auto-repeat
    }
    this.held.set(code, startVoice(bus, transpose(base, this.octave * 12)))
    // Light by the key's BASE pitch, so a key always lights the same node
    // whatever the octave shift.
    this.strike(this.keyNode.get(base), bus.ctx.currentTime)

    return true
  }

  // Piano note-off: release the key's held voice (quick fade). No-op if not held.
  noteOff(code: string): void {
    const voices = this.held.get(code)

    if (!voices || !this.bus) {
      return
    }
    this.held.delete(code)
    releaseVoice(this.bus.ctx, voices)
  }

  // Release every held note — a safety for lost keyups (window blur / focus
  // change), so a note can't drone on forever.
  releaseAll(): void {
    if (!this.bus) {
      return
    }

    for (const voices of this.held.values()) {
      releaseVoice(this.bus.ctx, voices)
    }
    this.held.clear()
  }

  // Shift the piano up/down whole octaves (Z/X), clamped to a sane range.
  shiftOctave(dir: number): void {
    this.octave = Math.max(-3, Math.min(3, this.octave + dir))
  }

  // Glow strength (0–1) for a node this frame, or 0 when cold — exponential decay
  // from its most recent strike. The canvas pairs this with the node's own colour.
  // Under prefers-reduced-motion the decay is stretched several times over, which
  // turns the whole field from a strobe into a slow breath: the beat still reads,
  // but nothing flashes four times a second at someone who asked it not to.
  intensityFor(id: string): number {
    const bus = this.bus

    if (!bus) {
      return 0
    }
    const t = this.hits.get(id)

    if (t == null) {
      return 0
    }
    const dt = bus.ctx.currentTime - t

    if (dt < 0) {
      return 0
    }
    const a = Math.exp(-dt / (this.reduced ? REDUCED_GLOW_TAU : GLOW_TAU))

    return a > 0.01 ? a : 0
  }

  // Leave the mode: silence everything, fade the buses out and let the view know.
  // `onEnd` fires on EVERY path through here, including an already-stopped engine:
  // the caller has handed us its keyboard, and the callback is how it gets it back,
  // so an early return that skips it would leave the app mute to shortcuts.
  stop(): void {
    const cb = this.onEnd
    this.onEnd = null
    this.active = false
    cancelAnimationFrame(this.raf)
    this.raf = 0

    if (this.requeue) {
      clearInterval(this.requeue)
      this.requeue = null
    }
    this.motion?.removeEventListener?.('change', this.onMotion)
    this.motion = null

    if (this.bus) {
      closeBus(this.bus)
    }
    this.bus = null
    this.medley = null
    this.hits.clear()
    this.pending = []
    this.melodyVoices = []
    this.tailVoices = []
    this.held.clear()
    this.octave = 0
    // Let the graph slice go. The engine outlives a single run (the view keeps it
    // to answer stray keyups), and holding the nodes, edges and group buckets would
    // pin the whole snapshot for as long as the page lives.
    this.nodes = []
    this.byId = new Map()
    this.adj = new Map()
    this.groupMembers = new Map()
    this.keyNode.clear()
    this.groupOf = null
    cb?.()
  }

  // Light a node. With `cluster`, also light a couple of its same-group members,
  // so a cluster of one colour lights up together in its region of the graph;
  // without it, just the single node (the bare-lead intro). Original colours are
  // kept — the canvas only brightens them.
  private strike(nodeId: string | undefined, t: number, cluster = true): void {
    if (nodeId == null) {
      return
    }
    this.hits.set(nodeId, t)

    if (!cluster) {
      return
    }
    const node = this.byId.get(nodeId)
    const key = node && this.groupOf ? this.groupOf(node) : null

    if (key == null) {
      return
    }
    const members = this.groupMembers.get(key)

    if (!members || members.length < 2) {
      return
    }

    for (let k = 0; k < 2; k++) {
      const id = members[Math.floor(Math.random() * members.length)]

      if (id !== nodeId) {
        this.hits.set(id, t)
      }
    }
  }

  // Start a looping medley: the theme through a list of arrangements, each in its
  // own key, chained seamlessly and re-queued just before it runs out (in `loop`)
  // so it never stops.
  private startMedley(segments: readonly PulseSegment[]): void {
    if (!this.bus) {
      return
    }
    const end = this.scheduleCycle(segments, this.bus.ctx.currentTime + 0.1, true)
    this.medley = { segments, nextAt: end }
    this.pending.sort((a, b) => a.at - b.at)
  }

  // Schedule every segment back-to-back; return the end time. The bare-lead intro
  // pass plays only on the FIRST cycle (`withIntro`) — on every loop after that
  // the segments drop straight into their groove, so the build-up never repeats.
  private scheduleCycle(segments: readonly PulseSegment[], t0: number, withIntro: boolean): number {
    const bus = this.bus!
    let t = t0

    for (const seg of segments) {
      // Sweep a riser into each segment's downbeat to smooth the cut. Skipped for
      // the very first downbeat (nothing precedes it); it lands on every later
      // segment and — because the re-queue lookahead is longer than the riser — on
      // every loop boundary too.
      if (t - RISER_SEC > bus.ctx.currentTime) {
        this.melodyVoices.push(...riser(bus, t, RISER_SEC))
      }
      t = this.scheduleSegment({ ...seg, intro: withIntro && seg.intro }, t)
    }

    return t
  }

  // Schedule one arrangement segment: an optional bare-lead intro pass, then a
  // full-groove pass, transposed by `seg.semis`. Returns its end time.
  private scheduleSegment(seg: PulseSegment, t0: number): number {
    const bus = this.bus!
    const spb = 60 / seg.bpm
    const passes = seg.intro ? [false, true] : [true] // false = lead-only intro pass
    const perPass = KOROBEINIKI.reduce((s, b) => s + b.lead.filter(([n]) => n).length, 0)
    const path = buildPath(this.nodes, this.adj, perPass * passes.length)
    let pi = 0
    let t = t0

    for (const full of passes) {
      KOROBEINIKI.forEach((bar, index) => {
        const barStart = t
        const root = transpose(bar.root, seg.semis)
        let beat = 0

        for (const [name, beats] of bar.lead) {
          if (name) {
            const s = barStart + beat * spb
            const dur = Math.max(0.12, beats * spb * 0.9)
            this.melodyVoices.push(...voice(bus, transpose(name, seg.semis), s, dur))
            // The bare-lead intro pass lights one node at a time; the full passes
            // light same-colour clusters.
            this.pending.push({ at: s, nodeId: path[pi], cluster: full })
            pi++
          }
          beat += beats
        }
        this.melodyVoices.push(
          ...groove(bus, seg.style, {
            t: barStart,
            spb,
            beats: BEATS_PER_BAR,
            root,
            full,
            index,
          }),
        )
        t += BEATS_PER_BAR * spb
      })
    }

    return t
  }

  // Silence the current tune, drop the medley and the pending lights. Both the
  // queued cycle AND the tail of the one before it are killed: the re-queue runs
  // seconds before the current cycle actually ends, so at any moment there can be
  // sounding voices in `tailVoices` that `melodyVoices` no longer knows about.
  // The mix is ducked first — stopping an oscillator mid-waveform IS the click.
  private stopMelody(): void {
    this.medley = null

    if (!this.bus) {
      return
    }
    const at = duckOut(this.bus)

    for (const o of [...this.melodyVoices, ...this.tailVoices]) {
      try {
        o.stop(at)
      } catch {
        /* already stopped */
      }
    }
    this.melodyVoices = []
    this.tailVoices = []
    this.pending = []
  }

  // Two clocks, because they answer to different masters.
  //
  // The LIGHT runs on the animation frame: it only matters while the page is being
  // painted, and freezing with the tab is exactly right. It does NOT drive the
  // canvas — force-graph repaints on its own rAF (kept awake by
  // autoPauseRedraw=false) and reads intensityFor() live.
  //
  // The MUSIC runs on a timer: a backgrounded tab stops rAF, but the audio clock
  // keeps going, so an rAF-driven re-queue would let the tune run out and never
  // resume. Timers are throttled in the background (~1s), well inside the lookahead.
  private loop(): void {
    const tick = () => {
      if (!this.active || !this.bus) {
        return
      }
      const now = this.bus.ctx.currentTime
      let i = 0

      while (i < this.pending.length && this.pending[i].at <= now) {
        this.strike(this.pending[i].nodeId, this.pending[i].at, this.pending[i].cluster)
        i++
      }

      if (i > 0) {
        this.pending.splice(0, i)
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    this.requeue = setInterval(() => this.extendMedley(), REQUEUE_POLL_MS)
  }

  // Queue the next cycle once the current one is within the lookahead. The start
  // time is clamped to "now": after a long freeze `nextAt` can be in the past, and
  // scheduling a whole cycle backwards would dump every voice of it into one
  // instant. The lookahead is longer than a riser, so the riser that smooths the
  // loop seam actually has room to sweep.
  private extendMedley(): void {
    const bus = this.bus

    if (!bus || !this.medley) {
      return
    }
    const now = bus.ctx.currentTime

    // The light clock (rAF) is frozen while the tab is hidden, so nothing has been
    // draining the strike queue — drop what it would only have skipped anyway,
    // otherwise a page left in the background grows it by a cycle every cycle.
    if (this.pending.length && this.pending[0].at < now) {
      this.pending = this.pending.filter((p) => p.at >= now)
    }

    if (now <= this.medley.nextAt - REQUEUE_LEAD_SEC) {
      return
    }
    // The cycle that's still sounding becomes the tail; the array is reused for the
    // one about to be queued. Keeping both means a toggle-off can silence
    // everything, and memory stays bounded at two cycles.
    this.tailVoices = this.melodyVoices
    this.melodyVoices = []
    this.medley.nextAt = this.scheduleCycle(
      this.medley.segments,
      Math.max(this.medley.nextAt, now + 0.1),
      false,
    )
  }
}

// The engine's full surface — for the view that drives it (the canvas needs only
// PulseGlow). Exported as a type so a caller can hold the lazily-built instance
// without a static import of the module itself.
export type PulseEngine = GraphPulse

// A blueprint, not a live thing: the owner of the run builds its own engine and
// drops it when done, so nothing here outlives a session (a module-scope instance
// would keep the audio chain and the graph slice alive for the whole page).
export const createGraphPulse = (): PulseEngine => new GraphPulse()
