import { useEffect, useRef, useState } from 'react'
import type {
  PulseEngine,
  PulseGlow,
  PulseGraph,
  PulseNode,
} from '../../../../libs/graph/graphPulse'
import { useHotkeys } from '../../../HotkeysProvider'
import { PULSE_SETTLE_MS, PULSE_TRIGGER_GAP_MS, PULSE_TRIGGER_TAPS } from '../../consts'
import { gestureAllowed, isTyping } from './helpers'

// What to play, sampled at the moment the trigger fires: the graph as it is
// currently shown (filters applied) and the colour grouping the canvas paints it
// with, so the lighting matches what's on screen.
export type PulseSource<N extends PulseNode> = () => {
  graph: PulseGraph<N>
  groupOf?: (node: N) => string | null
}

/** Five taps on the space bar and the graph page starts playing itself; the
 *  keyboard becomes a piano over it. Returns the running engine (which the canvas
 *  reads its glow off) or null.
 *
 *  The gesture is deliberate — auto-repeat from a held key is ignored, the run
 *  resets after a pause or any other key, and it never fires while typing, while a
 *  control has focus, or behind a modal. The engine is imported lazily, so it stays
 *  out of the everyday bundle. */
export const useGraphPulse = <N extends PulseNode>(source: PulseSource<N>): PulseGlow | null => {
  const [pulse, setPulse] = useState<PulseGlow | null>(null)
  const engineRef = useRef<PulseEngine | null>(null)
  // Read through refs so the listener binds once: the graph slice changes with
  // every filter tweak, and re-binding on each would drop a half-typed run.
  const sourceRef = useRef(source)
  sourceRef.current = source
  const { setRecording } = useHotkeys()
  const standDownRef = useRef(setRecording)
  standDownRef.current = setRecording

  useEffect(() => {
    let taps = 0
    let last = 0
    // The tail of the run (a sixth, seventh tap) would otherwise land inside the
    // mode and silence the tune it just started, so the space bar is deaf for a
    // moment right after the gesture lands.
    let settledAt = 0
    let starting = false
    let disposed = false

    const start = async () => {
      if (starting) {
        return // the chunk is still on its way; a second gesture must not race it
      }
      starting = true

      try {
        const { graph, groupOf } = sourceRef.current()
        const { createGraphPulse } = await import('../../../../libs/graph/graphPulse')

        if (disposed) {
          return // the view went away while the chunk loaded — nothing to start
        }
        const engine = createGraphPulse()
        // Hand the keyboard over ONLY once the mode is really up: an engine that
        // refuses to start (empty graph, no Web Audio) must not leave the app's
        // shortcuts stood down with nothing left to stand them back up.
        const running = engine.start(graph, {
          groupOf,
          onEnd: () => {
            standDownRef.current(false)
            setPulse(null)
          },
        })

        if (!running) {
          return
        }
        engineRef.current = engine
        standDownRef.current(true)
        // A fresh view object every time: the engine instance itself is a stable
        // reference, and on a second run React would skip the re-render that wakes
        // the canvas out of its power-saving redraw. `reduced` is a getter, not a
        // copy — the system setting can flip mid-run, and the canvas has to see it
        // (it gates both the bloom and the floor) without another render.
        setPulse({
          active: true,
          get reduced() {
            return engine.reduced
          },
          intensityFor: (id: string) => engine.intensityFor(id),
        })
      } finally {
        starting = false
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const engine = engineRef.current
      const el = document.activeElement

      // The way out comes first, ahead of any "don't disturb" guard: wherever the
      // focus happens to be, Escape has to end the mode — it's the only exit.
      if (engine?.active && e.key === 'Escape') {
        engine.stop()

        return
      }

      if (isTyping(el)) {
        return
      }

      if (engine?.active) {
        // Browser/OS combinations stay the browser's (Cmd-Tab, Ctrl-W…).
        if (e.metaKey || e.ctrlKey || e.altKey) {
          return
        }

        // Tab is swallowed BEFORE the auto-repeat guard below: holding it down is
        // exactly how focus would walk off onto a control behind the mode, and
        // every repeat past the first would have escaped a guard placed later.
        if (e.code === 'Tab') {
          e.preventDefault()

          return
        }

        if (e.repeat) {
          return
        }

        // Space → stop/start the melody (the piano stays live either way).
        if (e.code === 'Space') {
          e.preventDefault()

          if (e.timeStamp > settledAt) {
            engine.toggleMelody()
          }

          return
        }

        // Z / X → shift the piano an octave down / up (GarageBand-style).
        if (e.code === 'KeyZ' || e.code === 'KeyX') {
          e.preventDefault()
          engine.shiftOctave(e.code === 'KeyZ' ? -1 : 1)

          return
        }

        // Piano note-on, keyed by the PHYSICAL key so it plays in any layout
        // (Cyrillic included); the note sustains until keyup.
        if (e.code && engine.noteOn(e.code)) {
          e.preventDefault()
        }

        // Anything else is swallowed too: while it runs, the keyboard is ours.
        return
      }

      if (e.code !== 'Space' || !gestureAllowed(el)) {
        taps = 0

        return
      }

      if (e.repeat) {
        return
      }
      taps = e.timeStamp - last < PULSE_TRIGGER_GAP_MS ? taps + 1 : 1
      last = e.timeStamp

      if (taps >= PULSE_TRIGGER_TAPS) {
        taps = 0
        settledAt = e.timeStamp + PULSE_SETTLE_MS
        // A failed chunk load (offline, a stale service worker) must stay a
        // non-event: the mode simply doesn't open, and nothing was stood down yet.
        start().catch(() => {})
      }
    }

    // Release a piano note when its key is let go; release everything when the
    // window loses focus (a missed keyup — Cmd-Tab — would hang a note).
    const onKeyUp = (e: KeyboardEvent) => engineRef.current?.noteOff(e.code)
    const onBlur = () => engineRef.current?.releaseAll()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      disposed = true
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      // stop() always runs its onEnd, so leaving the page hands the keyboard back
      // as well.
      engineRef.current?.stop()
      engineRef.current = null
    }
  }, [])

  return pulse
}
