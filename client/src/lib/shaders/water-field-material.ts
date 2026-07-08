import * as THREE from 'three'
import { NodeMaterial } from 'three/webgpu'
import {
  Fn,
  uniform,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  sin,
  smoothstep,
  mix,
  clamp,
  pow,
  fract,
  max,
  abs,
  length,
  exp,
  reflect,
  varying,
  normalize,
  dot,
  positionLocal,
  modelWorldMatrix,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraNear,
  cameraFar,
  viewportLinearDepth,
} from 'three/tsl'
import { PI, gerstnerWave, gerstnerNormal } from './gerstner'
import { sampleNormalNoise } from './tsl-noise'
import {
  waterFallbackTex,
  waterWetnessFallbackTex,
  waterHeightFallbackTex,
  waveConfigs,
  getCloudTexture,
  sampleCloudPhoto,
  toHeightmapUV,
} from './water-types'
import { waterFieldFallbackTex } from '../utils/water-quad-geometry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any // TSL node — broad type for internal helper params

/**
 * Unified water shader: one mesh + one material per tile renders the sea,
 * rivers, and the estuary between them. The mesh's vertex Y carries the
 * baked water-field surface (flat `SEA_LEVEL` for sea-only tiles); the
 * field texture's `riverness` channel cross-fades sea behavior (Gerstner
 * waves, foam bands, caustics, wet sand) against river behavior (flowmap
 * ripples, river palette, bank alpha ramp).
 *
 * Shoreline (with `pixelDepth`): instead of fading shallow water to
 * near-transparent (the old sea shader's approach — it made the water
 * plane read as a floating sheet when the player stood in it), the
 * intersection with terrain/entities is resolved per-pixel against the
 * opaque depth buffer: a ~6 cm soft blend at the contact line, a foam
 * edge band above it, and Beer-Lambert absorption of the refracted bed.
 * Entities standing in water get the same treatment for free — they're
 * in the opaque depth. Without `pixelDepth` (MSAA presets, where the
 * depth copy is unavailable) a compressed heightmap-depth alpha ramp
 * stands in.
 */

export interface WaterFieldMaterialOptions {
  heightmapTexture: THREE.Texture
  waterField: THREE.Texture
  normalMap: THREE.Texture
  foamMap: THREE.Texture
  causticsMap: THREE.Texture
  refractionMap?: THREE.Texture | null
  reflectionMap?: THREE.Texture | null
  wetnessMap?: THREE.Texture | null
  /** Per-pixel depth-buffer shoreline. Must be false when the canvas is
   *  multisampled (antialias preset) — the framebuffer depth copy the
   *  `viewportDepthTexture` node performs cannot source an MSAA buffer. */
  pixelDepth?: boolean
}

export interface WaterFieldMaterialUniforms {
  uTime: { value: number }
  uSunDirection: { value: THREE.Vector3 }
  uSunColor: { value: THREE.Color }
  uCameraDirection: { value: THREE.Vector3 }
  uMoonBrightness: { value: number }
  uTorchPos: { value: THREE.Vector3 }
  uTorchColor: { value: THREE.Color }
  uTorchIntensity: { value: number }
  uTorchDistance: { value: number }
  uRefractionMap: { value: THREE.Texture }
  uReflectionMap: { value: THREE.Texture }
  uHeightmapTexture: { value: THREE.Texture }
  uWaterField: { value: THREE.Texture }
  uNormalMap: { value: THREE.Texture }
  uFoamMap: { value: THREE.Texture }
  uCausticsMap: { value: THREE.Texture }
  uWetnessMap: { value: THREE.Texture }
  uWaveA: { value: THREE.Vector4 }
  uWaveB: { value: THREE.Vector4 }
  uWaveC: { value: THREE.Vector4 }
}

export interface WaterFieldMaterialResult {
  material: NodeMaterial
  uniforms: WaterFieldMaterialUniforms
}

// Pre-baked tileable value noise texture (512×512, 64 periods with
// smoothstep interpolation baked in). A texture beats procedural
// hash+valueNoise Fn()s here: inlining them ballooned the WGSL and
// pipeline compile time.
let _noiseTex: THREE.Texture | null = null
function getNoiseTexture(): THREE.Texture {
  if (!_noiseTex) {
    const loader = new THREE.TextureLoader()
    _noiseTex = loader.load('/textures/value-noise.jpg')
    _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping
    _noiseTex.minFilter = THREE.LinearMipMapLinearFilter
    _noiseTex.magFilter = THREE.LinearFilter
  }
  return _noiseTex
}
const NOISE_PERIODS = 64

/** Shoreline wash timing shared by the shore mask, foam bands, and the
 *  wetness capture material — all three must agree or the wet-sand trace
 *  desyncs from the visible wave. */
const SHORE_WAVE_SPEED = 0.012

/** Animated receding-wave shore mask (shared with the wetness capture
 *  material). `holeAlpha` ≈ 1 in the water body, dipping toward 0 inside
 *  the wave-synced noise holes near the waterline; `holeEdge` /
 *  `holeFoamFringe` outline those holes for foam. */
function buildShoreMaskNodes(
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

export function createWaterFieldMaterial(
  options: WaterFieldMaterialOptions
): WaterFieldMaterialResult {
  const pixelDepth = options.pixelDepth ?? false

  // ── Uniforms ──
  const uTime = uniform(0)
  const makeWaveVec = (cfg: (typeof waveConfigs)[number]) =>
    new THREE.Vector4(
      Math.sin(cfg.angle),
      Math.cos(cfg.angle),
      cfg.steepness,
      cfg.wavelength
    )
  const uWaveA = uniform(makeWaveVec(waveConfigs[0]))
  const uWaveB = uniform(makeWaveVec(waveConfigs[1]))
  const uWaveC = uniform(makeWaveVec(waveConfigs[2]))

  // Sea palette (4-stop) + river palette (3-stop) — blended by riverness.
  const uVeryShallowColor = uniform(new THREE.Color(0.75, 0.88, 0.78))
  const uShallowColor = uniform(new THREE.Color(0.2, 0.58, 0.42))
  const uMidColor = uniform(new THREE.Color(0.02, 0.34, 0.32))
  const uDeepColor = uniform(new THREE.Color(0.002, 0.06, 0.18))
  const uRiverShallowColor = uniform(new THREE.Color(0.18, 0.32, 0.32))
  const uRiverMidColor = uniform(new THREE.Color(0.04, 0.12, 0.18))
  const uRiverDeepColor = uniform(new THREE.Color(0.02, 0.05, 0.12))

  /** Sea scatter-gradient depth normalization (m). */
  const uMaxDepth = uniform(2.5)
  /** River gradient/alpha depth plateau (m) — matches the bake's
   *  `RIVER_DEPTH_OFFSET_M = 0.5` channel depth. */
  const uRiverMaxDepth = uniform(0.5)
  /** Beer-Lambert absorption per meter of view distance through water
   *  (pixelDepth only). Red absorbs fastest, as in real water. */
  const uAbsorption = uniform(new THREE.Vector3(0.45, 0.15, 0.08))

  const uSunDirection = uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize())
  const uSunColor = uniform(new THREE.Color(1.0, 0.95, 0.8))
  const uCameraDirection = uniform(new THREE.Vector3(0, -1, 0))
  const uMoonBrightness = uniform(0)
  const uRefractionStrength = uniform(0.1)
  const uTorchPos = uniform(new THREE.Vector3(0, -1000, 0))
  const uTorchColor = uniform(new THREE.Color(1.0, 0.8, 0.4))
  const uTorchIntensity = uniform(0)
  const uTorchDistance = uniform(50)

  // ── Texture Nodes ──
  const heightmapTex = texture(options.heightmapTexture)
  const waterFieldTex = texture(options.waterField)
  const normalMapTex = texture(options.normalMap)
  const foamMapTex = texture(options.foamMap)
  const causticsTex = texture(options.causticsMap)
  const refractionTex = texture(options.refractionMap ?? waterFallbackTex)
  const reflectionTex = texture(options.reflectionMap ?? waterFallbackTex)
  const refractionMixScale = float(options.refractionMap ? 1 : 0)
  const reflectionMixScale = float(options.reflectionMap ? 1 : 0)
  const wetnessMapTex = texture(options.wetnessMap ?? waterWetnessFallbackTex)
  const noiseTex = texture(getNoiseTexture())
  const cloudTex = texture(getCloudTexture())

  // ── Varyings ──
  const vOrigWorldPos = varying(vec3(0), 'v_origWorldPos')
  const vWorldPos = varying(vec3(0), 'v_worldPos')
  const vWaveHeight = varying(float(0), 'v_waveHeight')
  const vClipPos = varying(vec4(0), 'v_clipPos')
  const vUv = varying(vec2(0), 'v_uv')

  const sampleNoise = (noiseCoord: N) =>
    noiseTex.sample(noiseCoord.div(NOISE_PERIODS)).r

  // ── Vertex Shader ─────────────────────────────────────
  // Vertex Y already carries the baked water surface. Gerstner waves are
  // added on top, damped both by shallow water (as the old sea shader
  // did) and by riverness so river ribbons stay flow-rippled, not wavy.

  const positionNode = Fn(() => {
    const localPos = positionLocal.toVar()
    vUv.assign(uv())

    const worldPos = modelWorldMatrix.mul(vec4(localPos, 1.0)).toVar()
    vOrigWorldPos.assign(worldPos.xyz)

    const p = worldPos.xyz
    const hUV = toHeightmapUV(vUv)
    const vtxTerrainH = heightmapTex.sample(hUV).r
    const vtxRiverness = waterFieldTex.sample(hUV).a
    const vtxDepth = max(float(0), p.y.sub(vtxTerrainH))
    // Cubic ease keeps endpoints fixed but compresses the shallow half so
    // the emerald band stays calm — a plain smoothstep read as choppy
    // once the cloud reflection amplified the perceived wave motion.
    const waveDamping = pow(
      smoothstep(float(0.0), float(1.5), vtxDepth),
      float(3.0)
    ).mul(float(1).sub(vtxRiverness))

    const offset = gerstnerWave(uWaveA, p, uTime)
      .add(gerstnerWave(uWaveB, p, uTime))
      .add(gerstnerWave(uWaveC, p, uTime))
      .mul(waveDamping)
      .toVar()

    worldPos.xyz.addAssign(offset)
    vWaveHeight.assign(offset.y)
    vWorldPos.assign(worldPos.xyz)

    const clipPos = cameraProjectionMatrix.mul(cameraViewMatrix).mul(worldPos)
    vClipPos.assign(clipPos)

    return clipPos
  })()

  // ── Fragment Shader ───────────────────────────────────

  const fragmentNode = Fn(() => {
    const sunY = uSunDirection.y
    const LUMA_REC601 = vec3(0.299, 0.587, 0.114)
    const sampleUV = clamp(toHeightmapUV(vUv), 0.0, 1.0)

    // ── Field + analytic (heightmap) depth ──
    const field = waterFieldTex.sample(sampleUV)
    const riverness = field.a.toVar()
    const seaness = float(1).sub(riverness).toVar()
    const flow = field.gb.toVar() // magnitude = baked estuary-decayed speed
    // Geographic river-influence gate (successor of the old splatmap-G
    // byte). Baked flow magnitude is ≥ 0.3 × radial-envelope inside the
    // channel and exactly 0 outside, so it marks "near a river" even at
    // the mouth where the estuary gate has already zeroed riverness —
    // without it, sea foam bands / cloud highlights / shore wash would
    // paint right across the estuary ribbon.
    const riverProxGate = float(1)
      .sub(smoothstep(float(0.02), float(0.2), length(flow)))
      .toVar()
    // Sea surface-effect gate: off inside inland channels (riverness) AND
    // near mouths (flow proximity).
    const seaFxGate = seaness.mul(seaness).mul(riverProxGate).toVar()
    const bedHeight = heightmapTex.sample(sampleUV).r
    const depth = max(float(0), vOrigWorldPos.y.sub(bedHeight)).toVar()
    const depthFactorSea = clamp(depth.div(uMaxDepth), 0.0, 1.0)
    const depthFactorRiver = clamp(depth.div(uRiverMaxDepth), 0.0, 1.0)
    const depthFactor = mix(depthFactorSea, depthFactorRiver, riverness)

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
      gerstnerN.add(rippleNoise.xzy.mul(vec3(1.5, 0.0, 1.5)))
    )

    // River ripples: two-phase wrapped flowmap. Unbounded `flow × time`
    // UV drift decorrelates neighbouring fragments at Voronoi seams and
    // confluences into a vortex artifact; wrapping each phase in [0, 1]
    // and crossfading two half-period-offset phases hides the wrap.
    const NORMAL_SCALE = float(0.18)
    const buildWrappedDrift = (rate: N, flowVec: N) => {
      const phase = uTime.mul(rate)
      const pA = fract(phase)
      const pB = fract(phase.add(0.5))
      const mixW = abs(pA.sub(0.5)).mul(2.0)
      return { driftA: flowVec.mul(pA), driftB: flowVec.mul(pB), mixW }
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
        .sub(1.0)
      const sB = normalMapTex
        .sample(a.sub(offB))
        .add(normalMapTex.sample(b.sub(offB.mul(flowScale2))))
        .mul(0.5)
        .sub(1.0)
      const s = mix(sA, sB, mixW)
      return normalize(vec3(s.r.mul(1.2), float(1.0), s.g.mul(1.2)))
    }
    const {
      driftA: flowOffA,
      driftB: flowOffB,
      mixW: rippleMix,
    } = buildWrappedDrift(float(0.4), flow)
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
    const surfaceNormal = normalize(mix(seaN, riverN, riverness))

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
    const waterColor = mix(seaBody, riverBody, riverness).toVar()

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
      mix(uRefractionStrength, float(0.04), riverness)
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
    const drift1 = mix(
      vec2(spT, spT.mul(0.7)),
      flow.mul(spT.mul(1.25)),
      riverness
    )
    const drift2 = mix(
      vec2(spT.mul(0.6), spT),
      flow.mul(spT.mul(0.75)),
      riverness
    )
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
    const riverSparkle = smoothstep(float(1.35), float(1.5), sp1.add(sp2))
      .mul(3.0)
      .mul(depthFactorRiver)
    const sparkle = mix(seaSparkle, riverSparkle, riverness)
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
        mix(vec3(0.55, 0.65, 0.75), vec3(0.45, 0.62, 0.82), riverness).mul(
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
        mix(vec3(0.12, 0.25, 0.5), vec3(0.12, 0.35, 0.8), riverness).mul(
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
          .mul(mix(float(0.42), float(0.95), reflectionMixScale))
          .mul(riverness)
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
        cloudHorizonWeight.mul(twilightFactor).mul(0.85).mul(riverness)
      )
    )
    const nightCloudColor = mix(cloudColor, vec3(cloudLuma), 0.7)
      .mul(0.08)
      .add(vec3(0.004, 0.006, 0.01))
    skyReflection.assign(
      mix(
        skyReflection,
        nightCloudColor,
        cloudHorizonWeight.mul(nightFactor).mul(0.85).mul(riverness)
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
    const cycle1 = fract(uTime.mul(SHORE_WAVE_SPEED))
    const cycle2 = fract(uTime.mul(SHORE_WAVE_SPEED).add(0.5))
    const move1 = smoothstep(float(0), float(0.7), cycle1)
    const move2 = smoothstep(float(0), float(0.7), cycle2)

    const noisyD = depth
      .add(sampleNoise(vOrigWorldPos.xz.mul(0.3)).mul(0.15))
      .add(sampleNoise(vOrigWorldPos.xz.mul(0.15)).mul(0.1))
      .add(sampleNoise(vOrigWorldPos.xz.mul(0.2)).mul(0.3))
    const spawnDepth = float(1.5)
    const shoreDepth = float(0.15)
    const center1 = mix(spawnDepth, shoreDepth, move1)
    const center2 = mix(spawnDepth, shoreDepth, move2)
    const fade1 = smoothstep(float(0), float(0.1), cycle1).mul(
      float(1).sub(smoothstep(float(0.9), float(1), cycle1))
    )
    const fade2 = smoothstep(float(0), float(0.1), cycle2).mul(
      float(1).sub(smoothstep(float(0.9), float(1), cycle2))
    )
    const bw1 = float(0.04).add(float(0.1).mul(move1))
    const bw2 = float(0.04).add(float(0.1).mul(move2))
    const band1 = smoothstep(center1.sub(bw1), center1, noisyD)
      .mul(float(1).sub(smoothstep(center1, center1.add(bw1), noisyD)))
      .mul(fade1)
      .mul(
        smoothstep(
          float(0.2),
          float(0.5),
          sampleNoise(vOrigWorldPos.xz.mul(0.15).add(center1.mul(1.5)))
        )
      )
    const band2 = smoothstep(center2.sub(bw2), center2, noisyD)
      .mul(float(1).sub(smoothstep(center2, center2.add(bw2), noisyD)))
      .mul(fade2)
      .mul(
        smoothstep(
          float(0.2),
          float(0.5),
          sampleNoise(vOrigWorldPos.xz.mul(0.15).add(center2.mul(1.5)))
        )
      )
    const shoreDayNight = smoothstep(float(-0.05), float(0.1), sunY)
    const shoreBase = shore.holeEdge.mul(
      mix(float(0.5), float(1.4), shoreDayNight)
    )
    const foamGlow = float(1)
      .sub(smoothstep(float(0), float(0.4), depth))
      .mul(0.15)
    const foamTex1 = foamMapTex.sample(
      vOrigWorldPos.xz.mul(0.4).add(cycle1.mul(0.3))
    ).r
    const foamTex2 = foamMapTex.sample(
      vOrigWorldPos.xz.mul(0.4).add(cycle2.mul(0.3))
    ).r
    const shoreFoamTex = max(
      foamMapTex.sample(
        vOrigWorldPos.xz.mul(0.5).add(vec2(uTime.mul(0.006), uTime.mul(0.004)))
      ).r,
      foamMapTex.sample(
        vOrigWorldPos.xz.mul(0.35).sub(vec2(uTime.mul(0.003), uTime.mul(0.005)))
      ).r
    )
    const shoreBaseTex = shoreBase.mul(shoreFoamTex)
    const waveFoam = max(band1.mul(foamTex1), band2.mul(foamTex2))
    const foamWithTex = clamp(
      max(max(waveFoam, shoreBaseTex), foamGlow),
      0.0,
      1.0
    )
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
    const foamEdge = foamEdgeMask
      .mul(edgeFoamTex)
      .mul(smoothstep(float(0.25), float(0.7), edgeNoise).mul(0.7).add(0.3))
      .mul(mix(float(0.3), float(1.0), shoreDayNight))
      .mul(mix(float(0.25), float(1.0), seaFxGate))
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
    colorSea.addAssign(vec3(1, 1, 1).mul(shoreBaseTex.mul(0.4).mul(seaFxGate)))

    // ── River composite ──
    const riverFresnel = pow(float(1).sub(NdotV), float(2)).mul(0.5)
    const reflectionBase = mix(
      float(0.35),
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
    const color = mix(colorSea, colorRiver, riverness).toVar()
    color.addAssign(torchReflection)
    color.addAssign(vec3(1, 1, 1).mul(foamEdge.mul(0.8)))

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

    // River: bank-to-body ramp; deep water goes opaque at night so a
    // torch-lit bed doesn't bleed through the last few percent.
    const riverAlpha = mix(
      float(0.35),
      float(0.95),
      smoothstep(float(0.0), uRiverMaxDepth, depth)
    ).toVar()
    riverAlpha.assign(
      mix(riverAlpha, float(1.0), float(1).sub(dayFactor).mul(depthFactorRiver))
    )

    const alpha = mix(seaAlpha, riverAlpha, riverness)
      .add(foamEdge.mul(0.6))
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

  // ── Build Material ────────────────────────────────────

  const material = new NodeMaterial()
  material.transparent = true
  material.depthWrite = false
  // DoubleSide: river reaches slope downstream; under the tilted ortho
  // camera a FrontSide-only surface can open holes on steep drops.
  material.side = THREE.DoubleSide
  material.vertexNode = positionNode
  material.fragmentNode = fragmentNode

  return {
    material,
    uniforms: {
      uTime,
      uSunDirection,
      uSunColor,
      uCameraDirection,
      uMoonBrightness,
      uTorchPos,
      uTorchColor,
      uTorchIntensity,
      uTorchDistance,
      uRefractionMap: refractionTex,
      uReflectionMap: reflectionTex,
      uHeightmapTexture: heightmapTex,
      uWaterField: waterFieldTex,
      uNormalMap: normalMapTex,
      uFoamMap: foamMapTex,
      uCausticsMap: causticsTex,
      uWetnessMap: wetnessMapTex,
      uWaveA,
      uWaveB,
      uWaveC,
    },
  }
}

// ── Wetness capture material ─────────────────────────────
// The wetness pre-pass needs the shore mask's `holeAlpha` rendered from
// above into a per-tile RT. The old system reused the sea material with a
// `uCaptureMode` switch + a wave-steepness save/restore dance; a dedicated
// material is cheaper (one tiny pipeline, compiled once, shared across all
// tiles) and keeps depth-buffer nodes out of the capture RT, which has no
// depth texture to copy. Per-tile textures are swapped in via `.value`
// before each capture render.

export interface WaterCaptureMaterialResult {
  material: NodeMaterial
  uniforms: {
    uTime: { value: number }
    uHeightmapTexture: { value: THREE.Texture }
    uWaterField: { value: THREE.Texture }
  }
}

let _captureMaterial: WaterCaptureMaterialResult | null = null

export function getWaterCaptureMaterial(): WaterCaptureMaterialResult {
  if (_captureMaterial) return _captureMaterial

  const uTime = uniform(0)
  const heightmapTex = texture(waterHeightFallbackTex)
  const waterFieldTex = texture(waterFieldFallbackTex)
  const noiseTex = texture(getNoiseTexture())

  const vWorldPos = varying(vec3(0), 'wc_worldPos')
  const vUv = varying(vec2(0), 'wc_uv')

  const positionNode = Fn(() => {
    vUv.assign(uv())
    const worldPos = modelWorldMatrix.mul(vec4(positionLocal, 1.0))
    vWorldPos.assign(worldPos.xyz)
    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(worldPos)
  })()

  const fragmentNode = Fn(() => {
    const sampleUV = clamp(toHeightmapUV(vUv), 0.0, 1.0)
    const bedHeight = heightmapTex.sample(sampleUV).r
    const depth = max(float(0), vWorldPos.y.sub(bedHeight))
    const sampleNoise = (noiseCoord: N) =>
      noiseTex.sample(noiseCoord.div(NOISE_PERIODS)).r
    const shore = buildShoreMaskNodes(depth, vWorldPos, uTime, sampleNoise)
    // Rivers don't wet the sand (their banks have no wash animation), so
    // the captured alpha is gated out near river influence — riverness
    // for inland channels, flow magnitude for mouths (same pair of gates
    // as the main material's seaFxGate).
    const fieldSample = waterFieldTex.sample(sampleUV)
    const proxGate = float(1).sub(
      smoothstep(float(0.02), float(0.2), length(fieldSample.gb))
    )
    return vec4(
      0,
      0,
      0,
      shore.holeAlpha.mul(float(1).sub(fieldSample.a)).mul(proxGate)
    )
  })()

  const material = new NodeMaterial()
  material.transparent = true
  material.blending = THREE.NoBlending
  material.depthWrite = false
  material.side = THREE.DoubleSide
  material.vertexNode = positionNode
  material.fragmentNode = fragmentNode

  _captureMaterial = {
    material,
    uniforms: {
      uTime,
      uHeightmapTexture: heightmapTex,
      uWaterField: waterFieldTex,
    },
  }
  return _captureMaterial
}
