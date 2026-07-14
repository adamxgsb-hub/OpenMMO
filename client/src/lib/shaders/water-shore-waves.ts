import * as THREE from 'three'
import {
  float,
  fract,
  smoothstep,
  mix,
  floor,
  pow,
  clamp,
  min,
  max,
  sin,
  vec2,
  texture,
} from 'three/tsl'
import type { TextureNode } from 'three/webgpu'
import { PI } from './gerstner'
import {
  SHORE_WAVE_SPEED,
  WASH_RUNUP_START,
  WASH_RUNUP_END,
  BORE_FADE_END,
  WASH_FLUSH_START,
  WASH_FLUSH_END,
  MOVE_END,
  BRK_START_MOVE,
  BRK_END_MOVE,
  RECEDE_START,
  RECEDE_END,
} from './shore-wave-timing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any // TSL node — broad type for internal helper params

// Shore-wave simulation node library, shared by the water field vertex
// shader, its fragment shader, and the wetness-capture material. Every
// function here builds a TSL node graph; nothing runs on the CPU.

// Pre-baked tileable value noise texture (512×512, 64 periods with
// smoothstep interpolation baked in). A texture beats procedural
// hash+valueNoise Fn()s here: inlining them ballooned the WGSL and
// pipeline compile time.
let _noiseTex: THREE.Texture | null = null
export function getNoiseTexture(): THREE.Texture {
  if (!_noiseTex) {
    const loader = new THREE.TextureLoader()
    _noiseTex = loader.load('/textures/value-noise.jpg')
    _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping
    _noiseTex.minFilter = THREE.LinearMipMapLinearFilter
    _noiseTex.magFilter = THREE.LinearFilter
  }
  return _noiseTex
}
export const NOISE_PERIODS = 64

/** Value-noise sampler shared by the node factory and the capture material:
 *  wraps the tileable noise texture in a fresh `texture()` node and samples it
 *  in period space, so callers get the `noiseTex.sample(coord / NOISE_PERIODS)`
 *  node without re-importing the texture and period constant. */
export function makeNoiseSampler(): (c: N) => N {
  const noiseTex = texture(getNoiseTexture())
  return (noiseCoord: N) => noiseTex.sample(noiseCoord.div(NOISE_PERIODS)).r
}

/** Shore-swell shape: crests spawn at `SWELL_SPAWN_DEPTH` (m) and run up
 *  to `SWELL_SHORE_DEPTH` (≈ the waterline). The pulse starts low, broad,
 *  and symmetric; shoaling raises and narrows it, with the shoreward face
 *  steepening fastest. Breaking collapses it into a low, broad bore. Widths
 *  are in noisy depth-space meters. */
// Exported so the shore-spray effect can reconstruct the crest's depth
// travel (center = mix(SPAWN, SHORE, move)) and follow it CPU-side.
export const SWELL_SPAWN_DEPTH = 1.5
export const SWELL_SHORE_DEPTH = 0.03
const SWELL_SPAWN_AMP = 0.18
const SWELL_BREAK_AMP = 0.42
const SWELL_SPAWN_W = 0.55
const SWELL_BREAK_FRONT_W = 0.08
const SWELL_BREAK_BACK_W = 0.22
const SWELL_BORE_FRONT_W = 0.45
const SWELL_BORE_BACK_W = 0.75

/** Whitewash front geometry (noisyD depth units): the front sits just
 *  landward of the swell peak (PEAK_OFFSET), overshoots past the
 *  waterline analytically at full run-up, then receives a shallow-water
 *  render offset because the dry-land part is depth-occluded. It retreats
 *  seaward by FLUSH_RETREAT during the flush. Seaward the foam is hard-capped
 *  at WASH_BACK_DEPTH — where the wave broke (= the crest depth at break
 *  onset) — so the open sea never whitens. */
const WASH_PEAK_OFFSET = 0.08
const WASH_OVERSHOOT = -0.15
/** Visual compensation for the water-plane depth clip: the analytic run-up
 *  travels onto dry land, but that part of the sea-level mesh is occluded by
 *  terrain. Shift its foam footprint back into visible shallow water. */
const WASH_RUNUP_SEAWARD_SHIFT = 0.22
/** Smaller visibility compensation for the low post-break bore. It ramps in
 *  only after the whitecap has finished breaking so foam does not detach from
 *  the tall geometric crest. */
const BORE_FOAM_SEAWARD_SHIFT = 0.12
const WASH_FLUSH_RETREAT = 0.6
const WASH_BACK_DEPTH =
  SWELL_SPAWN_DEPTH + (SWELL_SHORE_DEPTH - SWELL_SPAWN_DEPTH) * BRK_START_MOVE

/** Swash-water sheet (noisyD depth units): the drained edge sits at
 *  SWASH_MAX_DEPTH between waves; the run-up sweeps the edge landward
 *  past the waterline to SWASH_RUNUP_OVERSHOOT so the strip floods with
 *  the whitewash. */
export const SWASH_MAX_DEPTH = 0.7
export const SWASH_RUNUP_OVERSHOOT = -0.45

/** Depth + per-wave world-space noise — the coordinate the shore bands and
 *  swell live in. The seed stays constant for one wave, then offsets the
 *  noise field when that phase starts its next cycle, giving every wave a
 *  different but stable ragged front. Must stay identical between vertex
 *  (swell displacement) and fragment (foam) or the whitecap slides off the
 *  geometric crest. */
export function buildNoisyDepth(
  depth: N,
  worldXZ: N,
  waveSeed: N,
  sampleNoise: (c: N) => N
): N {
  const waveOffset = vec2(waveSeed.mul(17.13), waveSeed.mul(29.71))
  return depth
    .add(sampleNoise(worldXZ.mul(0.3).add(waveOffset)).mul(0.15))
    .add(
      sampleNoise(
        worldXZ.mul(0.15).add(vec2(waveSeed.mul(31.37), waveSeed.mul(11.79)))
      ).mul(0.1)
    )
    .add(
      sampleNoise(
        worldXZ.mul(0.2).add(vec2(waveSeed.mul(7.43), waveSeed.mul(23.17)))
      ).mul(0.3)
    )
    .toVar()
}

/** One traveling shore-wave phase. `move` runs the crest from spawn depth
 *  to the waterline over the first MOVE_END of the cycle; `brk` is
 *  breaking progress — the swell collapses and the whitecap blooms as
 *  the crest passes BRK_START_MOVE of its travel; the broken bore then
 *  rides the rest of the way in under its foam front.
 *  `fade` kills the swell and its foam right after landfall, so the
 *  backwash is bare water — only the whitewash sheet (see
 *  `buildPhaseFoam`) and the anchored residue stay behind. `seed` is a
 *  per-wave constant that decorrelates each wave's residue pattern. Two
 *  half-offset phases give a continuous wave train. */
export function buildShoreWavePhase(uTime: N, offset: number) {
  const cycle = fract(uTime.mul(SHORE_WAVE_SPEED).add(offset)).toVar()
  const move = smoothstep(float(0), float(MOVE_END), cycle).toVar()
  const center = mix(
    float(SWELL_SPAWN_DEPTH),
    float(SWELL_SHORE_DEPTH),
    move
  ).toVar()
  // Cross-fade the low bore during the opening of the longer run-up. Keeping
  // this fade short avoids stretching the geometric bore across the whole
  // run-up while its whitewash continues moving landward.
  const fade = smoothstep(float(0), float(0.1), cycle)
    .mul(
      float(1).sub(
        smoothstep(float(WASH_RUNUP_START), float(BORE_FADE_END), cycle)
      )
    )
    .toVar()
  const brk = smoothstep(
    float(BRK_START_MOVE),
    float(BRK_END_MOVE),
    move
  ).toVar()
  const seed = fract(
    floor(uTime.mul(SHORE_WAVE_SPEED).add(offset))
      .mul(0.618034)
      .add(offset * 0.754877666)
  ).toVar()
  // Backwash progress: 0 until landfall, → 1 as the sheet finishes
  // draining. Drives the swash-sheet edge, the residue's seaward drag
  // and dimming, and the receding-edge foam line.
  const receded = smoothstep(
    float(RECEDE_START),
    float(RECEDE_END),
    cycle
  ).toVar()
  // Whitewash sheet progress: `runup` pushes the broken foam front from
  // the break point up to the waterline; `flush` is the backwash pulling
  // it out — the sheet fades and slides seaward as flush → 1.
  const runup = smoothstep(
    float(WASH_RUNUP_START),
    float(WASH_RUNUP_END),
    cycle
  ).toVar()
  const flush = smoothstep(
    float(WASH_FLUSH_START),
    float(WASH_FLUSH_END),
    cycle
  ).toVar()
  return { cycle, move, center, fade, brk, seed, receded, runup, flush }
}

/** Swell displacement of one phase at `noisyD`: the asymmetric hump grows
 *  approaching the shore (shoaling) and collapses once it breaks. `prof`
 *  is the raw 0–1 shape, reused by the fragment as the whitecap mask. */
export function buildSwell(
  noisyD: N,
  depth: N,
  phase: ReturnType<typeof buildShoreWavePhase>
) {
  const s = noisyD.sub(phase.center)
  // Finish shoaling just as breaking starts. The front reaches its minimum
  // safe width first, reading as nearly vertical without becoming narrower
  // than the water mesh can resolve reliably.
  const shoal = smoothstep(float(0), float(BRK_START_MOVE), phase.move)
  const approachFrontW = mix(
    float(SWELL_SPAWN_W),
    float(SWELL_BREAK_FRONT_W),
    shoal
  )
  const approachBackW = mix(
    float(SWELL_SPAWN_W),
    float(SWELL_BREAK_BACK_W),
    shoal
  )
  // Let the cap form briefly at maximum steepness, then rapidly spread the
  // collapsing pulse into a low bore that continues toward the shoreline.
  const collapse = smoothstep(float(0.35), float(1), phase.brk)
  const frontW = mix(approachFrontW, float(SWELL_BORE_FRONT_W), collapse)
  const backW = mix(approachBackW, float(SWELL_BORE_BACK_W), collapse)
  // Near-triangular profile: linear faces keep a sharp crest kink right
  // on the foam line (smoothstep faces rounded it into a soft mound);
  // the mild pow tightens the toes without softening the peak.
  const prof = pow(
    clamp(min(s.div(frontW).add(1), float(1).sub(s.div(backW))), 0.0, 1.0),
    float(1.3)
  ).toVar()
  const shoalingAmp = mix(float(SWELL_SPAWN_AMP), float(SWELL_BREAK_AMP), shoal)
  // 75% collapse (not full): a low bore hump keeps traveling under the
  // foam front after the break, like a real spilling breaker.
  const amp = shoalingAmp.mul(phase.fade).mul(float(1).sub(collapse.mul(0.75)))
  // Feather at the true waterline so the crest never lifts dry sand.
  const height = prof.mul(amp).mul(smoothstep(float(0.03), float(0.18), depth))
  return { height, prof }
}

/** Animated receding-wave shore mask (shared with the wetness capture
 *  material). `holeAlpha` ≈ 1 in the water body, dipping toward 0 inside
 *  the wave-synced noise holes near the waterline; `holeEdge` /
 *  `holeFoamFringe` outline those holes for foam. */
export function buildShoreMaskNodes(
  depth: N,
  worldPos: N,
  uTime: N,
  sampleNoise: (c: N) => N
) {
  const shorePhase = uTime
    .mul(SHORE_WAVE_SPEED)
    .mul(PI.mul(4))
    .sub(PI.mul(1.0 / 2.0))
  const shoreRecede = sin(shorePhase).mul(0.5).add(0.5)
  const shoreAdjustedDepth = max(float(0), depth.sub(shoreRecede.mul(0.35)))
  const shoreZone = float(1).sub(
    smoothstep(float(0), float(0.45), shoreAdjustedDepth)
  )

  const sn1 = sampleNoise(worldPos.xz.mul(0.2).add(uTime.mul(0.07)))
  const sn2 = sampleNoise(worldPos.xz.mul(0.4).add(uTime.mul(0.04)))
  const sn3 = sampleNoise(worldPos.xz.mul(0.08).add(uTime.mul(0.1)))
  const holeMask = sn1.mul(0.5).add(sn2.mul(0.3)).add(sn3.mul(0.2))

  const edgeCutoff = smoothstep(float(0), float(0.01), depth)
  const holeThreshold = shoreZone.mul(0.9)
  const holeAlpha = smoothstep(
    holeThreshold.sub(0.05),
    holeThreshold.add(0.05),
    holeMask
  ).mul(edgeCutoff)

  const distFromHole = holeMask.sub(holeThreshold)
  const holeEdge = smoothstep(float(-0.03), float(0.01), distFromHole)
    .mul(float(1).sub(smoothstep(float(0.01), float(0.5), distFromHole)))
    .mul(shoreZone)
  const holeFoamFringe = smoothstep(float(-0.03), float(0.0), distFromHole).mul(
    shoreZone
  )

  return { holeAlpha, holeFoamFringe, holeEdge, shoreZone }
}

/** Fragment-local nodes the foam builders capture. Passed once so the
 *  returned closures read them like the inlined originals did. */
export interface ShoreFoamCtx {
  sampleNoise: (c: N) => N
  vOrigWorldPos: N
  // Concrete so `foamMapTex.sample(...).r` stays Node<"float"> — an `any`
  // here makes `.mul()` pick the vec broadcast overload and widens the
  // foam (and therefore the alpha it feeds) to vec3.
  foamMapTex: TextureNode
  landwardDir: N
}

/** Build the per-phase whitewash/residue and receding-edge foam closures
 *  for one fragment. They live in `noisyD` depth-space and share the
 *  `landwardDir` backwash drag, so keep them together. */
export function makeShoreFoamBuilders(ctx: ShoreFoamCtx) {
  const { sampleNoise, vOrigWorldPos, foamMapTex, landwardDir } = ctx

  // One phase's wave foam, following the real surf lifecycle:
  //  1. approach — a moderate foam line rides the traveling crest,
  //  2. breaking — at BRK_START_MOVE of the run-in the whitecap
  //     blooms as `brk` → 1 and the swell collapses into a low bore,
  //  3. bore + run-up — the whitewash front rides the bore the rest
  //     of the way in (foam only landward of the break point), then
  //     surges past the waterline over the swash strip,
  //  4. backwash — the flush fades the sheet fast while dragging it
  //     seaward; what stays is the residue: foam anchored to the
  //     ground (static per-wave UV, not drifting with the water) over
  //     the swash zone, dissolving into patches as a rising threshold
  //     eats the foam texture.
  const buildPhaseFoam = (
    phase: ReturnType<typeof buildShoreWavePhase>,
    noisyD: N
  ) => {
    const bw = float(0.04).add(float(0.1).mul(phase.move))
    const breakSpread = smoothstep(float(0), float(0.65), phase.brk)
    // Breaking completes near cycle 0.30. Delay the render-space shift
    // until afterwards so the cap stays attached to the steep crest, then
    // move the low bore foam into depth-visible shallow water.
    const boreSeawardShift = smoothstep(
      float(0.32),
      float(0.46),
      phase.cycle
    ).mul(BORE_FOAM_SEAWARD_SHIFT)
    const foamCenter = phase.center.add(boreSeawardShift)
    const foamFrontW = bw.mul(1.6).mul(mix(float(1), float(4), breakSpread))
    // Keep the foam footprint at a 70:30 front/back width ratio through
    // both the narrow approach and the breaking expansion.
    const foamBackW = foamFrontW.mul(3 / 7)
    const frontBiasedMask = float(1).sub(
      smoothstep(foamCenter, foamCenter.add(foamBackW), noisyD)
    )
    const foamProfile = smoothstep(
      foamCenter.sub(foamFrontW),
      foamCenter,
      noisyD
    ).mul(frontBiasedMask)
    const band = foamProfile
      .mul(phase.fade)
      .mul(
        smoothstep(
          float(0.2),
          float(0.5),
          sampleNoise(vOrigWorldPos.xz.mul(0.15).add(phase.center.mul(1.5)))
        )
      )
    // Breaking whitecap: rides the crest top; as the break completes
    // (right before the run-up) the cap densifies — its mask widens
    // down the swell faces (falling pow) and its texture becomes denser,
    // while the gain below keeps the widened bore from reaching solid
    // white across its whole footprint.
    const crest = pow(foamProfile, mix(float(2.0), float(1.3), phase.brk))
      .mul(phase.brk)
      .mul(phase.fade)
    const foamTex = foamMapTex.sample(
      vOrigWorldPos.xz.mul(0.4).add(phase.cycle.mul(0.3))
    ).r
    const crestTex = mix(foamTex, foamTex.mul(0.45).add(0.55), phase.brk)
    // The widened breaker/bore covers much more area than the approaching
    // band, so taper its peak intensity as it spreads instead of letting
    // that whole footprint reach solid white.
    const breakFoamGain = mix(float(1), float(0.6), phase.brk)
    const liveFoam = max(
      band.mul(mix(float(0.3), float(1.0), phase.brk)).mul(foamTex),
      crest.mul(crestTex).mul(float(1).add(phase.brk.mul(0.2)))
    ).mul(breakFoamGain)

    const resSpatial = float(1).sub(smoothstep(float(0.3), float(0.6), noisyD))
    // Residue must be gone by ~0.85: the OTHER phase (offset 0.5) has
    // visibly re-entered the swash zone by cycle ≈ 0.87, and a fresh
    // wave washing over the previous wave's leftovers reads wrong.
    const resTime = smoothstep(float(0.52), float(0.6), phase.cycle).mul(
      float(1).sub(smoothstep(float(0.72), float(0.86), phase.cycle))
    )
    const dissolve = smoothstep(float(0.6), float(0.84), phase.cycle)
    // Backwash drag: the pattern is sampled landward of the fragment
    // by a growing offset, so the leftover foam visibly slides seaward
    // with the receding sheet…
    const resTex = foamMapTex.sample(
      vOrigWorldPos.xz
        .add(landwardDir.mul(phase.receded.mul(2.0)))
        .mul(0.4)
        .add(vec2(phase.seed.mul(7.3), phase.seed.mul(4.1)))
    ).r
    // Residue is anchored to the shore after the crest has passed, so it
    // must not be clipped by the moving crest's front/back mask. A slightly
    // lower dissolve threshold keeps sparse patches present without adding
    // a differently shaped fallback band.
    const resThr = mix(float(0.28), float(0.72), dissolve)
    const residue = resSpatial
      .mul(resTime)
      .mul(smoothstep(resThr, resThr.add(0.2), resTex))
      .mul(0.55)
    // …and dims as it goes (color only — `residue` keeps the alpha).
    const residueLit = residue.mul(mix(float(1), float(0.35), phase.receded))

    // Whitewash sheet: the front rides the broken crest the rest of
    // the way in, sweeps past the waterline at full run-up, and the
    // flush pulls it back out seaward. Lives in the SAME noisyD
    // coordinate as the swell so the band snakes along the crest
    // wiggle for wiggle, sitting just landward of the peak — the foam
    // forms on the breaker's front face, never behind it. A NARROW
    // band riding the front, widening a little as the run-up spreads
    // it over the strip, hard-capped seaward at the break point.
    // Position and texture advection use linear travel progress: the eased
    // phase nodes intentionally slow at their endpoints, which made the
    // foam appear parked from late RUN-UP through early FLUSH.
    const runupTravel = clamp(
      phase.cycle
        .sub(WASH_RUNUP_START)
        .div(WASH_FLUSH_START - WASH_RUNUP_START),
      0.0,
      1.0
    )
    const flushTravel = clamp(
      phase.cycle.sub(WASH_FLUSH_START).div(WASH_FLUSH_END - WASH_FLUSH_START),
      0.0,
      1.0
    )
    const washFront = mix(
      phase.center.sub(WASH_PEAK_OFFSET),
      float(WASH_OVERSHOOT),
      runupTravel
    )
      .add(
        runupTravel.mul(float(1).sub(flushTravel)).mul(WASH_RUNUP_SEAWARD_SHIFT)
      )
      .add(flushTravel.mul(WASH_FLUSH_RETREAT))
      .toVar()
    const washBack = min(
      washFront.add(
        float(0.12).add(phase.brk.mul(0.1)).add(phase.runup.mul(0.2))
      ),
      float(WASH_BACK_DEPTH)
    )
    const washBand = smoothstep(
      washFront.sub(0.02),
      washFront.add(0.05),
      noisyD
    ).mul(float(1).sub(smoothstep(washBack, washBack.add(0.12), noisyD)))
    // Use the same linear progress for the texture so its internal pattern
    // stays locked to the moving band instead of pausing at the handoff.
    const washTex = foamMapTex.sample(
      vOrigWorldPos.xz
        .add(landwardDir.mul(flushTravel.mul(2.2).sub(runupTravel.mul(1.2))))
        .mul(0.35)
        .add(vec2(phase.seed.mul(5.7), phase.seed.mul(3.9)))
    ).r
    // Preserve texture holes from the start of run-up: a moderate threshold
    // rejects dark texels, while the small solid floor prevents the sheet
    // from becoming a flat white plate. FLUSH still raises the threshold to
    // shred the remaining foam into streaks.
    const runupWashThr = mix(float(0.3), float(0.42), runupTravel)
    const washThr = mix(runupWashThr, float(0.75), phase.flush)
    const washFade = float(1).sub(phase.flush)
    const washSolid = washFade.mul(mix(float(0.12), float(0.05), runupTravel))
    const wash = washBand
      .mul(phase.brk)
      .mul(washFade.mul(washFade))
      .mul(
        smoothstep(washThr, washThr.add(0.22), washTex)
          .mul(float(1).sub(washSolid))
          .add(washSolid)
      )
      // Intentional: keep the mask on the wash so the backwash fades in
      // the ~0.5 m depth band instead of sliding all the way to the break
      // line. Removing it lets the retreat overshoot seaward — visually
      // worse (confirmed by A/B), even though it looks like it clips the
      // flush band.
      .mul(frontBiasedMask)
      .mul(breakFoamGain)

    return { live: liveFoam, residue, residueLit, wash }
  }

  const recedeFadeOut = (phase: ReturnType<typeof buildShoreWavePhase>) =>
    phase.receded.mul(
      float(1).sub(
        smoothstep(
          float(RECEDE_END - 0.04),
          float(RECEDE_END + 0.03),
          phase.cycle
        )
      )
    )
  const buildRecedeEdgeFoam = (
    phase: ReturnType<typeof buildShoreWavePhase>,
    noisyD: N,
    swashThr: N
  ) =>
    smoothstep(swashThr.sub(0.06), swashThr, noisyD)
      .mul(
        float(1).sub(smoothstep(swashThr.add(0.03), swashThr.add(0.16), noisyD))
      )
      .mul(recedeFadeOut(phase))
      .mul(
        foamMapTex.sample(
          vOrigWorldPos.xz
            .add(landwardDir.mul(phase.receded.mul(2.0)))
            .mul(0.45)
            .add(vec2(phase.seed.mul(4.7), phase.seed.mul(8.3)))
        ).r
      )

  return { buildPhaseFoam, buildRecedeEdgeFoam }
}
