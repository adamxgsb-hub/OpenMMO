import {
  Fn,
  vec2,
  vec3,
  vec4,
  float,
  clamp,
  max,
  min,
  abs,
  mix,
  smoothstep,
  pow,
  sin,
  exp,
  fract,
  length,
  dot,
  normalize,
  reflect,
  cameraNear,
  cameraFar,
  viewportLinearDepth,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { gerstnerNormal } from './gerstner'
import { sampleNormalNoise } from './tsl-noise'
import { sampleCloudPhoto, toHeightmapUV } from './water-types'
import {
  buildNoisyDepth,
  buildShoreWavePhase,
  buildSwell,
  buildShoreMaskNodes,
  makeShoreFoamBuilders,
  SWASH_MAX_DEPTH,
  SWASH_RUNUP_OVERSHOOT,
} from './water-shore-waves'
import type { WaterFieldNodes } from './water-field-nodes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any // TSL node — broad type for internal helper params

/** DEBUG: paint the broken-wave residue red (instead of the normal white)
 *  so its lifetime/extent can be judged in isolation. */
const RESIDUE_DEBUG = false

/** DEBUG: paint the traveling shore-swell profile by face: red on the
 *  shoreward/front slope, blue on the seaward/back slope. */
const SWELL_PROFILE_DEBUG = false

/** Build the water field fragment node from the shared node set. Split out of
 *  createWaterFieldMaterial purely for file size; the node graph is identical. */
export function buildWaterFieldFragment(nodes: WaterFieldNodes): Node {
  const {
    pixelDepth,
    uTime,
    uSunDirection,
    uSunColor,
    uCameraDirection,
    uMoonBrightness,
    uMaxDepth,
    uRiverMaxDepth,
    uAbsorption,
    uRefractionStrength,
    uTorchPos,
    uTorchColor,
    uTorchIntensity,
    uTorchDistance,
    uVeryShallowColor,
    uShallowColor,
    uMidColor,
    uDeepColor,
    uRiverShallowColor,
    uRiverMidColor,
    uRiverDeepColor,
    uWaveA,
    uWaveB,
    uWaveC,
    heightmapTex,
    waterFieldTex,
    normalMapTex,
    foamMapTex,
    causticsTex,
    refractionTex,
    reflectionTex,
    wetnessMapTex,
    cloudTex,
    refractionMixScale,
    reflectionMixScale,
    vOrigWorldPos,
    vWorldPos,
    vWaveHeight,
    vClipPos,
    vUv,
    vBedGrad,
    sampleNoise,
  } = nodes

  const fragmentNode = Fn(() => {
    const sunY = uSunDirection.y
    const LUMA_REC601 = vec3(0.299, 0.587, 0.114)
    const sampleUV = clamp(toHeightmapUV(vUv), 0.0, 1.0)

    // ── Field + analytic (heightmap) depth ──
    const field = waterFieldTex.sample(sampleUV)
    const riverness = field.a.toVar()
    const seaness = float(1).sub(riverness).toVar()
    const flow = field.gb.toVar() // magnitude = baked estuary-decayed speed
    // (field.r carries the baked turbulence — consumed CPU-side by
    // river-rock placement and its drifting wake-foam particles, not
    // sampled here.)
    // Geographic river influence (successor of the old splatmap-G byte).
    // Baked flow magnitude is ≥ 0.3 × radial-envelope inside the channel
    // and exactly 0 outside, so it marks "near a river" even at the mouth
    // where the estuary gate has already zeroed riverness — without it,
    // sea foam bands / cloud highlights / shore wash would paint right
    // across the estuary ribbon.
    const flowProx = smoothstep(float(0.02), float(0.2), length(flow)).toVar()
    const riverProxGate = float(1).sub(flowProx).toVar()
    // Sea surface-effect gate: off inside inland channels (riverness) AND
    // near mouths (flow proximity).
    const seaFxGate = seaness.mul(seaness).mul(riverProxGate).toVar()
    // River-styling weight for palette/alpha: riverness alone drops to 0
    // at the mouth (estuary gate) while the water there is still visually
    // the river — flow proximity keeps the river palette and bank alpha
    // ramp all the way to the sea. Zero in open water (flow = 0).
    const riverStyleW = max(riverness, flowProx).toVar()
    const bedHeight = heightmapTex.sample(sampleUV).r
    const depth = max(float(0), vOrigWorldPos.y.sub(bedHeight)).toVar()
    const depthFactorSea = clamp(depth.div(uMaxDepth), 0.0, 1.0)
    const depthFactorRiver = clamp(depth.div(uRiverMaxDepth), 0.0, 1.0)
    const depthFactor = mix(depthFactorSea, depthFactorRiver, riverness)

    // ── Shore swell (fragment recompute of the vertex displacement) ──
    // Same phases as the foam bands below so the whitecap sits on the
    // geometric crest. The depth-space slope (finite difference) times
    // the bed gradient gives the world-space slope for the normal.
    const phaseA = buildShoreWavePhase(uTime, 0)
    const phaseB = buildShoreWavePhase(uTime, 0.5)
    const noisyDA = buildNoisyDepth(
      depth,
      vOrigWorldPos.xz,
      phaseA.seed,
      sampleNoise
    )
    const noisyDB = buildNoisyDepth(
      depth,
      vOrigWorldPos.xz,
      phaseB.seed,
      sampleNoise
    )
    const swellA = buildSwell(noisyDA, depth, phaseA)
    const swellB = buildSwell(noisyDB, depth, phaseB)
    const buildSwellDebugFaces = (
      noisyD: N,
      phase: ReturnType<typeof buildShoreWavePhase>,
      swell: ReturnType<typeof buildSwell>
    ) => {
      const s = noisyD.sub(phase.center)
      const active = swell.prof
        .mul(phase.fade)
        .mul(smoothstep(float(0.03), float(0.18), depth))
      // Depth decreases toward shore, so s < 0 is the incoming/front
      // face and s > 0 is the trailing, seaward/back face.
      const backWeight = smoothstep(float(-0.015), float(0.015), s)
      return {
        front: active.mul(float(1).sub(backWeight)),
        back: active.mul(backWeight),
      }
    }
    const debugFacesA = buildSwellDebugFaces(noisyDA, phaseA, swellA)
    const debugFacesB = buildSwellDebugFaces(noisyDB, phaseB, swellB)
    const swellDebugFront = max(debugFacesA.front, debugFacesB.front)
    const swellDebugBack = max(debugFacesA.back, debugFacesB.back)
    const SWELL_EPS = 0.08
    const swellSlopeD = buildSwell(noisyDA.add(SWELL_EPS), depth, phaseA)
      .height.add(buildSwell(noisyDB.add(SWELL_EPS), depth, phaseB).height)
      .sub(swellA.height.add(swellB.height))
      .div(SWELL_EPS)
    // Depth grows where the bed drops (d·depth/dx = −gradBed.x), so the
    // heightfield normal (−dh/dx, 1, −dh/dz) reduces to +slope × gradBed
    // (bed gradient interpolated from the vertex stage).
    const swellN = vec3(
      swellSlopeD.mul(vBedGrad.x),
      float(0),
      swellSlopeD.mul(vBedGrad.y)
    )

    // ── Swash transparency ──
    // The swash strip only holds water while a wave is in. Per phase the
    // sheet's edge is a depth threshold: on the run-in it hugs the
    // incoming crest (no standing water ahead of the wave — like the
    // drained strip in front of a breaker), then the run-up sweeps it
    // landward past the noise floor so the water boundary visibly rushes
    // up the strip with the whitewash, and the backwash pulls it back
    // out to SWASH_MAX_DEPTH. min() of the two phases: either phase's
    // water covers the strip.
    const swashThreshold = (phase: ReturnType<typeof buildShoreWavePhase>) => {
      const inThr = min(phase.center, float(SWASH_MAX_DEPTH))
      const runupThr = mix(inThr, float(SWASH_RUNUP_OVERSHOOT), phase.runup)
      return max(runupThr, phase.receded.mul(SWASH_MAX_DEPTH))
    }
    const swashThrA = swashThreshold(phaseA)
    const swashThrB = swashThreshold(phaseB)
    const swashWaterGate = mix(
      float(1),
      max(
        smoothstep(swashThrA, swashThrA.add(0.08), noisyDA),
        smoothstep(swashThrB, swashThrB.add(0.08), noisyDB)
      ),
      seaFxGate
    ).toVar()
    // Unit landward direction (the bed gradient points uphill). Sampling
    // the foam pattern landward of the fragment makes the pattern appear
    // to drift seaward — the backwash drag on the swash-zone foam.
    const landwardDir = vBedGrad.div(max(length(vBedGrad), float(0.02))).toVar()
    const { buildPhaseFoam, buildRecedeEdgeFoam } = makeShoreFoamBuilders({
      sampleNoise,
      vOrigWorldPos,
      foamMapTex,
      landwardDir,
    })

    // ── Per-pixel view distance through water (depth buffer) ──
    // Orthographic camera: NDC z is already linear in [near, far] and the
    // depth attachment stores it raw, so the water column the view ray
    // crosses is just Δdepth01 × (far − near). `vertDepth` projects that
    // onto the vertical axis — the water thickness above whatever opaque
    // surface (terrain, player, prop) the depth buffer saw.
    // `viewportLinearDepth` = linearDepth(viewportDepthTexture()): for an
    // orthographic camera that's the raw depth-attachment value, linear01
    // in [near, far]. Own-fragment depth comes from vClipPos (NOT the
    // built-in linearDepth — that derives from positionView, which never
    // sees the custom vertexNode's Gerstner displacement).
    const fragDepth01 = vClipPos.z.div(vClipPos.w)
    const viewDist = pixelDepth
      ? max(float(0), viewportLinearDepth.sub(fragDepth01))
          .mul(cameraFar.sub(cameraNear))
          .toVar()
      : depth.toVar()
    const vertDepth = pixelDepth
      ? viewDist.mul(abs(uCameraDirection.y)).toVar()
      : depth

    // ── Surface normal: Gerstner+ripple (sea) ⇄ flowmap ripple (river) ──
    const gnA = gerstnerNormal(uWaveA, vOrigWorldPos, uTime)
    const gnB = gerstnerNormal(uWaveB, vOrigWorldPos, uTime)
    const gnC = gerstnerNormal(uWaveC, vOrigWorldPos, uTime)
    const tx = float(1.0).add(gnA.x).add(gnB.x).add(gnC.x)
    const ty = gnA.y.add(gnB.y).add(gnC.y)
    const bz = float(1.0).add(gnA.z).add(gnB.z).add(gnC.z)
    const by = gnA.w.add(gnB.w).add(gnC.w)
    const gerstnerN = normalize(vec3(ty.negate(), tx.mul(bz), by.negate()))
    const rippleNoise = sampleNormalNoise(
      vOrigWorldPos.xz,
      normalMapTex,
      uTime,
      uWaveA,
      uWaveB,
      uWaveC
    )
    const seaN = normalize(
      gerstnerN
        .add(rippleNoise.xzy.mul(vec3(1.5, 0.0, 1.5)))
        .add(swellN.mul(float(1.8).mul(seaFxGate)))
    )

    // River ripples: two-phase wrapped flowmap. Unbounded `flow × time`
    // UV drift decorrelates neighbouring fragments at Voronoi seams and
    // confluences into a vortex artifact; wrapping each phase in [0, 1]
    // and crossfading two half-period-offset phases hides the wrap.
    // `waternormals` is conventionally encoded around 0.5. Decode the
    // averaged samples back to a signed vector before building the normal;
    // subtracting 1 after the average left an almost constant diagonal tilt
    // that hid the time-varying downstream ripple.
    const NORMAL_SCALE = float(0.18)
    // Wrap frequency of the two-phase crossfade. Must stay BOTH low and
    // spatially uniform:
    //  * above ~1 Hz the phases cross-dissolve faster than the eye can
    //    track, and (the blend's mean offset being a constant 0.5·drift)
    //    the pattern time-averages into a near-static shimmer — raising
    //    the rate made the river look SLOWER, which is how the old
    //    riverness-blended 4.0 inland rate silently did nothing;
    //  * a riverness-dependent rate lets fract(uTime·rate) diverge
    //    without bound between neighbouring fragments, shredding the
    //    estuary blend band into unrelated phases as uTime grows.
    // Perceived current is therefore tuned with the drift LENGTH per
    // cycle below, never with this rate:
    //   speed ≈ |flow| · driftLen · RIPPLE_WRAP_RATE / NORMAL_SCALE  [m/s]
    const RIPPLE_WRAP_RATE = float(0.35)
    // Inland: |flow| ≈ 1 mid-channel ⇒ ~1.9 m/s — a brisk, clearly legible
    // current (the baked flow map supplies direction and bank falloff).
    // NOTE: with the coast-distance estuary gate this now applies to the
    // whole inland course (plains included), not just mountain reaches.
    const RIVER_DRIFT_LEN = float(1.0)
    // Mouth: |flow| has decayed to 0.3 there ⇒ ~0.1 m/s, matching the
    // deliberately gentle drift the estuary already had.
    const ESTUARY_DRIFT_LEN = float(0.17)
    const buildWrappedDrift = (driftLen: N, flowVec: N) => {
      const phase = uTime.mul(RIPPLE_WRAP_RATE)
      const pA = fract(phase)
      const pB = fract(phase.add(0.5))
      const mixW = abs(pA.sub(0.5)).mul(2.0)
      const drift = flowVec.mul(driftLen)
      return { driftA: drift.mul(pA), driftB: drift.mul(pB), mixW }
    }
    const buildRippleN = (
      a: N,
      b: N,
      offA: N,
      offB: N,
      flowScale2: N,
      mixW: N
    ): N => {
      const sA = normalMapTex
        .sample(a.sub(offA))
        .add(normalMapTex.sample(b.sub(offA.mul(flowScale2))))
        .mul(0.5)
        .sub(0.5)
        .mul(2.0)
      const sB = normalMapTex
        .sample(a.sub(offB))
        .add(normalMapTex.sample(b.sub(offB.mul(flowScale2))))
        .mul(0.5)
        .sub(0.5)
        .mul(2.0)
      const s = mix(sA, sB, mixW)
      return normalize(vec3(s.r.mul(1.2), float(1.0), s.g.mul(1.2)))
    }
    const {
      driftA: flowOffA,
      driftB: flowOffB,
      mixW: rippleMix,
    } = buildWrappedDrift(
      // Keep the very slow mouth intact, but recover the inland current soon
      // after leaving it. This concentrates the deceleration at the sea end
      // instead of making the whole lower reach feel sluggish.
      mix(
        ESTUARY_DRIFT_LEN,
        RIVER_DRIFT_LEN,
        smoothstep(float(0.3), float(0.85), riverness)
      ),
      flow
    )
    const nBase1 = vOrigWorldPos.xz.mul(NORMAL_SCALE)
    const nBase2 = vOrigWorldPos.xz.mul(NORMAL_SCALE.mul(0.6)).add(vec2(0.3, 0))
    const riverN = buildRippleN(
      nBase1,
      nBase2,
      flowOffA,
      flowOffB,
      float(0.7),
      rippleMix
    )

    // Flow remains valid through the estuary even after `riverness` reaches
    // zero, so use the same styling weight that drives its colour/alpha.
    const surfaceNormal = normalize(mix(seaN, riverN, riverStyleW))

    // ── Body color ──
    const seaC1 = mix(
      uVeryShallowColor,
      uShallowColor,
      smoothstep(float(0.0), float(0.08), depthFactorSea)
    )
    const seaC2 = mix(
      seaC1,
      uMidColor,
      smoothstep(float(0.08), float(0.25), depthFactorSea)
    )
    const seaBody = mix(
      seaC2,
      uDeepColor,
      smoothstep(float(0.25), float(0.7), depthFactorSea)
    )
    const riverC1 = mix(
      uRiverShallowColor,
      uRiverMidColor,
      smoothstep(float(0.0), float(0.4), depthFactorRiver)
    )
    const riverBody = mix(
      riverC1,
      uRiverDeepColor,
      smoothstep(float(0.4), float(0.85), depthFactorRiver)
    )
    const waterColor = mix(seaBody, riverBody, riverStyleW).toVar()

    // ── View / screen ──
    const viewDir = normalize(vec3(uCameraDirection).negate())
    const screenUV = vClipPos.xy.mul(0.5).add(0.5)
    const screenUVFlipped = vec2(screenUV.x, float(1.0).sub(screenUV.y))

    // ── Time-of-day factors (shared) ──
    const nightFactor = float(1)
      .sub(smoothstep(float(-0.15), float(0.05), sunY))
      .toVar()
    const twilightFactor = smoothstep(float(-0.15), float(0.0), sunY).mul(
      float(1).sub(smoothstep(float(0.05), float(0.3), sunY))
    )
    const dayFactor = smoothstep(float(0.05), float(0.3), sunY)

    // ── Refraction ──
    const distort = surfaceNormal.xz.mul(
      mix(uRefractionStrength, float(0.04), riverStyleW)
    )
    const refrUV = clamp(screenUVFlipped.add(distort), 0.0, 1.0)
    const refrRaw = refractionTex.sample(refrUV).rgb.toVar()
    // Beer-Lambert: the bed seen through more water loses red first.
    if (pixelDepth) {
      const uAbs = vec3(uAbsorption)
      refrRaw.mulAssign(
        vec3(
          exp(viewDist.mul(uAbs.x).negate()),
          exp(viewDist.mul(uAbs.y).negate()),
          exp(viewDist.mul(uAbs.z).negate())
        )
      )
    }
    // Wet-sand darkening rides the refracted bed — where the wetness map
    // is high the bed reads as soaked sand (replaces the old transparent
    // "hole" reveal, which is gone with the opaque shoreline).
    const texelSize = float(1.0 / 256) // WETNESS_SIZE
    const rawWetness = wetnessMapTex
      .sample(vUv.add(vec2(texelSize, 0)))
      .r.add(wetnessMapTex.sample(vUv.add(vec2(texelSize.negate(), 0))).r)
      .add(wetnessMapTex.sample(vUv.add(vec2(0, texelSize))).r)
      .add(wetnessMapTex.sample(vUv.add(vec2(0, texelSize.negate()))).r)
      .mul(0.25)
    const wetness = smoothstep(float(0.2), float(0.7), rawWetness)
    const wetDarken = mix(float(1.0), float(0.55), wetness.mul(seaFxGate))
    refrRaw.mulAssign(wetDarken)

    // River-side night grading of the refracted bed.
    const refrLuma = dot(refrRaw, LUMA_REC601)
    const nightRefr = mix(refrRaw, vec3(refrLuma), nightFactor.mul(0.9)).mul(
      float(1).sub(nightFactor.mul(0.88))
    )
    const refrColor = mix(refrRaw, nightRefr, nightFactor.mul(riverness))

    const seaRefrMix = float(1)
      .sub(smoothstep(float(0.05), float(0.35), depthFactorSea))
      .mul(0.95)
    const riverRefrShallow = float(1)
      .sub(smoothstep(float(0.05), float(0.5), depthFactorRiver))
      .toVar()
    const refrMix = mix(seaRefrMix, riverRefrShallow.mul(0.85), riverness)
      .mul(refractionMixScale)
      .toVar()

    // Night-darken the sea body before mixing (river handles night via
    // the luma mute in its composite path).
    const waterNightFactor = smoothstep(float(-0.05), float(0.1), sunY)
      .mul(0.85)
      .add(0.15)
    waterColor.mulAssign(mix(waterNightFactor, float(1.0), riverness))
    waterColor.assign(mix(waterColor, refrColor, refrMix))

    // ── Caustics (sea only — the flow ripple field would fight it) ──
    const causticsGate = seaFxGate
    const cUV1 = vOrigWorldPos.xz
      .mul(0.1)
      .add(vec2(uTime.mul(0.015), uTime.mul(0.01)))
    const cUV2 = vOrigWorldPos.xz
      .mul(0.095)
      .sub(vec2(uTime.mul(0.008), uTime.mul(0.01)))
    const rawCaustics = causticsTex
      .sample(cUV1)
      .r.min(causticsTex.sample(cUV2).r)
    const causticsDetail = foamMapTex.sample(
      vOrigWorldPos.xz.mul(0.3).add(uTime.mul(0.01))
    ).r
    const causticsPattern = rawCaustics
      .min(float(0.5))
      .div(float(0.5))
      .mul(causticsDetail)
    const shimmer = sin(
      vOrigWorldPos.x.mul(0.4).add(vOrigWorldPos.z.mul(0.6)).add(uTime.mul(0.5))
    )
      .mul(0.4)
      .add(0.8)
    const causticsStrength = float(1).sub(
      smoothstep(float(0), float(0.5), depthFactorSea)
    )
    const causticsNight = smoothstep(float(-0.05), float(0.1), sunY)
    const causticsLight = mix(
      vec3(0.08, 0.1, 0.15),
      uSunColor.rgb,
      causticsNight
    )
    const causticsDepthGate = smoothstep(
      float(0.05),
      float(0.25),
      depthFactorSea
    )
    waterColor.addAssign(
      causticsLight
        .mul(causticsPattern.mul(shimmer).mul(1.2))
        .mul(causticsStrength)
        .mul(causticsDepthGate)
        .mul(causticsGate)
    )

    // ── Specular + sparkles (blended normal, blended magnitudes) ──
    const specNormal = normalize(mix(vec3(0, 1, 0), surfaceNormal, 0.3))
    const halfDir = normalize(vec3(uSunDirection).add(viewDir))
    const NdotH = max(dot(specNormal, halfDir), 0.0)
    const specular = uSunColor.rgb
      .mul(pow(NdotH, float(128)).mul(mix(float(0.3), float(0.35), riverness)))
      .toVar()

    const spT = uTime.mul(0.04)
    const drift1 = vec2(spT, spT.mul(0.7))
    const drift2 = vec2(spT.mul(0.6), spT)
    const sp1 = normalMapTex.sample(vWorldPos.xz.mul(0.5).add(drift1)).r
    const sp2 = normalMapTex.sample(vWorldPos.xz.mul(0.8).sub(drift2)).g
    const waveCrestFactor = smoothstep(float(-0.05), float(0.1), vWaveHeight)
      .mul(0.8)
      .add(0.2)
    const sunSparkleStrength = smoothstep(
      float(0),
      float(0.15),
      uSunDirection.y
    ).mul(float(0.3).add(float(0.7).mul(uSunDirection.y)))
    const moonSparkleStrength = float(1)
      .sub(smoothstep(float(-0.05), float(0.05), uSunDirection.y))
      .mul(0.15)
      .mul(smoothstep(float(0), float(0.1), uMoonBrightness))
    const seaSparkle = smoothstep(float(1.3), float(1.45), sp1.add(sp2))
      .mul(8.0)
      .mul(waveCrestFactor)
      .mul(max(sunSparkleStrength, moonSparkleStrength))
    // River motion comes solely from its flow-advected normal map. Keep the
    // sea's glitter out of the river/estuary instead of adding a second,
    // more conspicuous motion layer.
    const sparkle = seaSparkle.mul(float(1).sub(riverStyleW))
    specular.addAssign(uSunColor.rgb.mul(sparkle))

    // ── Sky reflection (shared structure, riverness-blended palettes) ──
    const reflNormal = normalize(
      mix(vec3(0, 1, 0), surfaceNormal, mix(float(0.3), float(0.05), riverness))
    )
    const reflectDir = reflect(viewDir.negate(), reflNormal)
    const skyY = clamp(reflectDir.y.mul(0.5).add(0.5), 0.0, 1.0)

    const groundColor = mix(
      vec3(0.02, 0.03, 0.06),
      vec3(0.012, 0.015, 0.022),
      riverness
    )
      .mul(nightFactor)
      .add(vec3(0.12, 0.06, 0.04).mul(twilightFactor))
      .add(vec3(0.08, 0.12, 0.15).mul(dayFactor))
    const hazeColorBase = mix(
      vec3(0.04, 0.06, 0.12),
      vec3(0.021, 0.026, 0.035),
      riverness
    )
      .mul(nightFactor)
      .add(vec3(0.7, 0.35, 0.15).mul(twilightFactor))
      .add(
        mix(vec3(0.55, 0.65, 0.75), vec3(0.28, 0.42, 0.68), riverness).mul(
          dayFactor
        )
      )
    const zenithColor = mix(
      vec3(0.02, 0.04, 0.1),
      vec3(0.015, 0.019, 0.03),
      riverness
    )
      .mul(nightFactor)
      .add(vec3(0.15, 0.1, 0.25).mul(twilightFactor))
      .add(
        mix(vec3(0.12, 0.25, 0.5), vec3(0.08, 0.22, 0.55), riverness).mul(
          dayFactor
        )
      )

    const sunsetFactor = smoothstep(float(-0.05), float(0.0), sunY).mul(
      float(1).sub(smoothstep(float(0.0), float(0.3), sunY))
    )
    const hazeColor = mix(
      hazeColorBase,
      uSunColor.rgb.mul(0.6),
      sunsetFactor.mul(0.5)
    )
    const skyReflection = mix(
      mix(groundColor, hazeColor, smoothstep(float(0), float(0.35), skyY)),
      zenithColor,
      smoothstep(float(0.35), float(0.7), skyY)
    ).toVar()
    const sunDot = max(dot(reflectDir, vec3(uSunDirection)), 0.0)
    skyReflection.addAssign(uSunColor.rgb.mul(pow(sunDot, float(8)).mul(0.25)))

    // ── Cloud photo (one sample, applied river-style + sea-style) ──
    const cloudReflNormal = normalize(mix(vec3(0, 1, 0), surfaceNormal, 0.05))
    const cloudReflectDir = reflect(viewDir.negate(), cloudReflNormal)
    const { cloudColor, cloudWeight } = sampleCloudPhoto(
      cloudReflectDir,
      vWorldPos.xz,
      uTime,
      dayFactor,
      cloudTex
    )
    // River: clouds fold into the sky reflection…
    skyReflection.assign(
      mix(
        skyReflection,
        cloudColor,
        cloudWeight
          .mul(mix(float(0.26), float(0.6), reflectionMixScale))
          .mul(riverStyleW)
      )
    )
    // …with sunset/night grading so night rivers don't mirror a day photo.
    const cloudLuma = dot(cloudColor, LUMA_REC601)
    const cloudHorizonWeight = smoothstep(float(0.15), float(0.45), skyY)
    const sunsetCloudColor = mix(cloudColor, vec3(cloudLuma), 0.52)
      .mul(vec3(0.62, 0.18, 0.075))
      .mul(0.12)
      .add(vec3(0.006, 0.003, 0.0015).mul(sunsetFactor))
    skyReflection.assign(
      mix(
        skyReflection,
        sunsetCloudColor,
        cloudHorizonWeight.mul(twilightFactor).mul(0.85).mul(riverStyleW)
      )
    )
    const nightCloudColor = mix(cloudColor, vec3(cloudLuma), 0.7)
      .mul(0.08)
      .add(vec3(0.004, 0.006, 0.01))
    skyReflection.assign(
      mix(
        skyReflection,
        nightCloudColor,
        cloudHorizonWeight.mul(nightFactor).mul(0.85).mul(riverStyleW)
      )
    )

    // ── Entity reflection (planar pass) ──
    const reflectionSample = reflectionTex.sample(
      clamp(screenUVFlipped.add(surfaceNormal.xz.mul(0.01)), 0.0, 1.0)
    )
    skyReflection.assign(
      mix(
        skyReflection,
        reflectionSample.rgb,
        reflectionSample.a.mul(0.5).mul(reflectionMixScale)
      )
    )

    // ── Shore wash + foam bands (sea side) ──
    const shore = buildShoreMaskNodes(depth, vOrigWorldPos, uTime, sampleNoise)
    const shoreDayNight = smoothstep(float(-0.05), float(0.1), sunY)
    const foamA = buildPhaseFoam(phaseA, noisyDA)
    const foamB = buildPhaseFoam(phaseB, noisyDB)
    const residueFoam = max(foamA.residue, foamB.residue).toVar()
    const residueLitFoam = max(foamA.residueLit, foamB.residueLit).toVar()
    // Whitewash composites like the residue — an independent layer with
    // its own alpha — so the run-up sheet can ride ahead of the swash
    // water and the flushing sheet stays visible on the draining strip.
    const washFoam = max(foamA.wash, foamB.wash).toVar()
    // Residue is NOT folded into the water foam: it composites as an
    // independent layer after the alpha, so it stays visible on the bare
    // sand once the swash water has drained out from under it.
    const waveFoam = max(foamA.live, foamB.live)

    // Receding-waterline foam: a dim ragged line riding the sheet's
    // seaward-moving edge through the backwash, gone once the strip has
    // fully drained. Its texture shares the backwash drag so the streaks
    // pull seaward with the edge.
    const recedeEdgeFoam = max(
      buildRecedeEdgeFoam(phaseA, noisyDA, swashThrA),
      buildRecedeEdgeFoam(phaseB, noisyDB, swashThrB)
    )
      .mul(seaFxGate)
      .toVar()
    const foamWithTex = clamp(waveFoam, 0.0, 1.0)
    const foamDepthMask = float(1)
      .sub(smoothstep(float(0.3), float(0.7), depthFactorSea))
      .mul(0.7)
      .add(0.3)
    const foamAddStrength = mix(float(0.06), float(0.7), shoreDayNight)
    const foamAdd = vec3(1, 1, 1).mul(
      foamWithTex.mul(foamAddStrength).mul(foamDepthMask)
    )

    // ── Pixel-depth foam edge: hugs every water↔opaque contact line —
    // the beach, rocks, and players' legs alike. ──
    const foamEdgeMask = pixelDepth
      ? float(1)
          .sub(smoothstep(float(0.02), float(0.35), vertDepth))
          .mul(smoothstep(float(0.0), float(0.02), vertDepth))
      : float(0)
    const edgeFoamTex = foamMapTex.sample(
      vOrigWorldPos.xz.mul(0.45).add(vec2(uTime.mul(0.008), uTime.mul(0.005)))
    ).r
    const edgeNoise = sampleNoise(
      vOrigWorldPos.xz.mul(0.35).add(uTime.mul(0.05))
    )
    // No standing contact foam on the beach waterline: the shore's
    // boundary foam is owned entirely by the wave cycle (whitecap →
    // residue → receding edge line). Contact lines in deeper water —
    // rocks, players' legs — keep it.
    const swashEdgeSuppress = float(1).sub(
      float(1)
        .sub(
          max(
            smoothstep(float(0.45), float(0.6), noisyDA),
            smoothstep(float(0.45), float(0.6), noisyDB)
          )
        )
        .mul(seaFxGate)
    )
    const foamEdge = foamEdgeMask
      .mul(edgeFoamTex)
      .mul(smoothstep(float(0.25), float(0.7), edgeNoise).mul(0.7).add(0.3))
      .mul(mix(float(0.3), float(1.0), shoreDayNight))
      .mul(mix(float(0.25), float(1.0), seaFxGate))
      .mul(swashWaterGate)
      .mul(swashEdgeSuppress)
      .toVar()

    // ── Torch reflection (was river-only; depth-gated so it stays subtle) ──
    const torchVec = uTorchPos.sub(vWorldPos)
    const torchLen = length(torchVec)
    const torchAtten = pow(
      max(float(0), float(1).sub(torchLen.div(uTorchDistance))),
      float(2)
    )
    const torchDir = torchVec.div(max(torchLen, float(0.001)))
    const torchSpecNormal = normalize(mix(vec3(0, 1, 0), surfaceNormal, 0.75))
    const torchHalfDir = normalize(torchDir.add(viewDir))
    const torchNdotH = max(dot(torchSpecNormal, torchHalfDir), 0.0)
    const torchReflection = uTorchColor.rgb
      .mul(pow(torchNdotH, float(48)))
      .mul(torchAtten.mul(torchAtten))
      .mul(uTorchIntensity)
      .mul(0.004)
      .mul(depthFactor)

    // ── Fresnel base ──
    const fresnelViewDir = normalize(vec3(viewDir.x, float(0.15), viewDir.z))
    const NdotV = max(dot(surfaceNormal, fresnelViewDir), 0.0)
    const rippleBright = mix(
      mix(float(0.75), float(0.85), riverness),
      mix(float(1.25), float(1.2), riverness),
      pow(float(1).sub(NdotV), float(1.5))
    )
    waterColor.mulAssign(rippleBright)

    // ── Sea composite ──
    const tintedSkyReflection = mix(
      skyReflection,
      uMidColor.rgb.mul(1.3),
      float(0.7)
    )
    const shallowDamp = smoothstep(float(0.1), float(0.4), depthFactorSea)
    const seaFresnel = pow(float(1).sub(NdotV), float(2)).mul(0.08)
    const colorSea = mix(
      waterColor,
      tintedSkyReflection,
      mix(float(0.005), float(0.06), shallowDamp).add(seaFresnel)
    )
      .add(specular.mul(shallowDamp))
      .toVar()
    // Cloud overlay on the deep body, gated OUT of the emerald shallows
    // where the photo's blue-sky pedestal would push the coastal green
    // toward blue; the complement window below re-adds only the BRIGHT
    // cloud shapes there as a pure-white lift so the green survives.
    const cloudDepthGate = smoothstep(float(0.25), float(0.55), depthFactorSea)
    colorSea.assign(
      mix(
        colorSea,
        cloudColor,
        cloudWeight.mul(
          cloudDepthGate.mul(mix(float(0.18), float(0.65), reflectionMixScale))
        )
      )
    )
    const cloudLumMax = max(cloudColor.r, max(cloudColor.g, cloudColor.b))
    const cloudBrightMask = smoothstep(float(0.4), float(0.95), cloudLumMax)
    const highlightBandGate = smoothstep(
      float(0.05),
      float(0.15),
      depthFactorSea
    )
      .mul(float(1).sub(cloudDepthGate))
      .mul(riverProxGate)
    colorSea.assign(
      mix(
        colorSea,
        vec3(1, 1, 1),
        cloudWeight
          .mul(
            highlightBandGate.mul(
              mix(float(0.08), float(0.25), reflectionMixScale)
            )
          )
          .mul(cloudBrightMask)
      )
    )
    colorSea.assign(
      mix(
        colorSea,
        reflectionSample.rgb,
        reflectionSample.a.mul(0.3).mul(reflectionMixScale)
      )
    )
    const nightDarken = smoothstep(float(-0.05), float(0.1), sunY)
      .mul(0.75)
      .add(0.25)
    const midDepthWeight = smoothstep(
      float(0.15),
      float(0.35),
      depthFactorSea
    ).mul(float(1).sub(smoothstep(float(0.5), float(0.8), depthFactorSea)))
    const nightExtra = float(1).sub(
      float(1).sub(nightDarken).mul(midDepthWeight).mul(0.35)
    )
    colorSea.mulAssign(nightDarken.mul(nightExtra))
    colorSea.addAssign(foamAdd.mul(seaFxGate))

    // ── River composite ──
    const riverFresnel = pow(float(1).sub(NdotV), float(2)).mul(0.5)
    const reflectionBase = mix(
      float(0.24),
      float(0.05),
      riverRefrShallow.mul(0.9)
    )
    const depthReflLift = smoothstep(float(0.04), float(0.35), depthFactorRiver)
    const reflectionMixRiver = clamp(
      reflectionBase
        .add(riverFresnel)
        .add(depthReflLift.mul(twilightFactor).mul(0.18))
        .add(depthReflLift.mul(nightFactor).mul(0.28))
        .mul(mix(float(0.58), float(1.0), reflectionMixScale)),
      0.0,
      0.9
    )
    const colorRiver = mix(waterColor, skyReflection, reflectionMixRiver)
      .add(specular.mul(depthFactorRiver))
      .toVar()
    colorRiver.assign(
      mix(
        colorRiver,
        reflectionSample.rgb,
        reflectionSample.a.mul(0.3).mul(reflectionMixScale)
      )
    )
    const riverNightLuma = dot(colorRiver, LUMA_REC601)
    const riverNightMuted = mix(
      colorRiver,
      vec3(riverNightLuma),
      nightFactor.mul(0.28)
    ).mul(float(1).sub(nightFactor.mul(0.14)))
    colorRiver.assign(mix(colorRiver, riverNightMuted, nightFactor))

    // ── Blend + global additions ──
    const color = mix(colorSea, colorRiver, riverStyleW).toVar()
    color.addAssign(torchReflection)
    color.addAssign(vec3(1, 1, 1).mul(foamEdge.mul(0.8)))
    const residueTint = RESIDUE_DEBUG
      ? vec3(1.5, 0, 0)
      : vec3(1, 1, 1).mul(foamAddStrength)
    color.addAssign(
      residueTint
        .mul(RESIDUE_DEBUG ? residueFoam : residueLitFoam)
        .mul(seaFxGate)
    )
    color.addAssign(
      vec3(1, 1, 1).mul(foamAddStrength).mul(washFoam).mul(seaFxGate)
    )
    // Receding edge line: darker than the live foam — thin dirty water,
    // not fresh whitewash.
    color.addAssign(
      vec3(0.5, 0.52, 0.55)
        .mul(recedeEdgeFoam)
        .mul(mix(float(0.15), float(0.6), shoreDayNight))
    )
    if (SWELL_PROFILE_DEBUG) {
      const debugTotal = swellDebugFront.add(swellDebugBack)
      const debugMask = clamp(debugTotal, 0.0, 1.0).mul(seaFxGate)
      const debugColor = vec3(swellDebugFront, 0, swellDebugBack).div(
        max(debugTotal, float(0.0001))
      )
      color.assign(mix(color, debugColor, debugMask))
    }

    // ── Alpha ──
    // Sea: high floor (the bed shows through the refraction color, not
    // through framebuffer transparency — that's what killed the old
    // floating-sheet look), mild receding-wave modulation for the wash.
    const seaAlpha = max(
      mix(
        float(0.55),
        float(0.92),
        smoothstep(float(0.0), float(0.25), depthFactorSea)
      ),
      seaRefrMix.mul(refractionMixScale).mul(0.9)
    )
      .add(foamWithTex.mul(seaFxGate).mul(0.9))
      .add(sparkle)
      .min(1.0)
      .mul(
        mix(
          float(1.0),
          mix(float(0.75), float(1.0), shore.holeAlpha),
          seaFxGate
        )
      )
      .toVar()
    // Night alpha reduction for very shallow sea (as before, gentler).
    const veryShallowWeight = float(1).sub(
      smoothstep(float(0.0), float(0.08), depthFactorSea)
    )
    seaAlpha.mulAssign(
      float(1).sub(float(1).sub(nightDarken).mul(veryShallowWeight).mul(0.35))
    )
    // Fully drain the swash strip between waves (bare wet sand shows).
    seaAlpha.mulAssign(swashWaterGate)

    // River: bank-to-body ramp; deep water goes opaque at night so a
    // torch-lit bed doesn't bleed through the last few percent.
    // Near-zero floor with a 5 cm dead zone keeps water off the bank slope.
    // Fade it in over just 10 cm so a character does not reveal a long,
    // semi-transparent strip before reaching the actual channel depth.
    const riverAlpha = mix(
      float(0.02),
      float(0.95),
      smoothstep(float(0.05), float(0.15), depth)
    ).toVar()
    riverAlpha.assign(
      mix(riverAlpha, float(1.0), float(1).sub(dayFactor).mul(depthFactorRiver))
    )

    // River ramp by riverStyleW, not riverness: at the mouth the estuary
    // gate zeroes riverness while the bank-taper sheet still hugs the
    // grassy banks, and the sea path's 0.55 floor (with swash drained off
    // by seaFxGate there) would render that sheet as standing floodwater.
    const alpha = mix(seaAlpha, riverAlpha, riverStyleW)
      .add(foamEdge.mul(0.6))
      .add(residueFoam.mul(seaFxGate))
      .add(washFoam.mul(seaFxGate))
      .add(recedeEdgeFoam.mul(0.5))
      .min(1.0)
      .toVar()

    // ── Shoreline edge cut ──
    // pixelDepth: ~6 cm soft blend against the opaque depth buffer —
    // pixel-exact around terrain AND entities. The analytic heightmap
    // edge is multiplied in as well: where water and terrain are
    // near-coplanar (sandbar tips), the depth-test clip line zigzags
    // per-triangle, and only the bilinear heightmap contour is smooth —
    // fading alpha on it hides the jagged geometric cut. Entities aren't
    // in the heightmap, so their contact stays purely pixel-depth.
    // Fallback: analytic contact only — coarser, but never floats.
    const edgeBlend = pixelDepth
      ? smoothstep(float(0.0), float(0.06), vertDepth).mul(
          smoothstep(float(0.0), float(0.04), depth)
        )
      : smoothstep(float(0.0), float(0.02), depth)
    alpha.mulAssign(edgeBlend)

    return vec4(color, alpha)
  })()

  return fragmentNode
}
