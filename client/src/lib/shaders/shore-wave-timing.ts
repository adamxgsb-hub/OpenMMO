/**
 * Shore-wave cycle timing, in a dependency-light module so the debug
 * overlay (WavePhaseDebug.svelte) can read it without pulling in the
 * WebGPU material builder. The shader (water-field-material.ts) builds
 * its phase nodes from these same values, so the on-screen readout
 * can't drift from the shader.
 */

/** Shoreline wash timing shared by the shore mask, foam bands, and the
 *  wetness capture material — all three must agree or the wet-sand trace
 *  desyncs from the visible wave. */
export const SHORE_WAVE_SPEED = 0.012

/** Whitewash timing: the shortened bore carries the wash into the shallows,
 *  then a long run-up keeps it moving through the final approach/overshoot.
 *  The near-zero peak avoids a stationary foam sheet before the backwash
 *  flushes it seaward over [FLUSH_START, FLUSH_END]. */
export const WASH_RUNUP_START = 0.4
export const BORE_FADE_END = 0.44
export const WASH_RUNUP_END = 0.62
export const WASH_FLUSH_START = 0.63
export const WASH_FLUSH_END = 0.72

/** Crest-travel and backwash cycle fractions (see buildShoreWavePhase
 *  in water-field-material.ts). The recede starts with the flush so the
 *  water/land boundary visibly pulls seaward while the foam fades, and
 *  keeps draining through the backwash. */
export const MOVE_END = 0.6
export const BRK_START_MOVE = 0.35
export const BRK_END_MOVE = 0.5
export const RECEDE_START = WASH_FLUSH_START
export const RECEDE_END = 0.85

/** The subset the wave-phase debug overlay renders. */
export const SHORE_WAVE_TIMING = {
  speed: SHORE_WAVE_SPEED,
  moveEnd: MOVE_END,
  brkStartMove: BRK_START_MOVE,
  brkEndMove: BRK_END_MOVE,
  recedeEnd: RECEDE_END,
  runupStart: WASH_RUNUP_START,
  runupEnd: WASH_RUNUP_END,
  flushStart: WASH_FLUSH_START,
  flushEnd: WASH_FLUSH_END,
} as const
