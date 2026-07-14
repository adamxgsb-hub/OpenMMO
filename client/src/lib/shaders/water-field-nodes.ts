import * as THREE from 'three'
import { uniform, texture, varying, float, vec2, vec3, vec4 } from 'three/tsl'
import {
  waterFallbackTex,
  waterWetnessFallbackTex,
  waveConfigs,
  getCloudTexture,
} from './water-types'
import { makeNoiseSampler } from './water-shore-waves'

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

/** Create every uniform, texture node, varying, and derived scale the water
 *  field material's vertex and fragment shaders read. Returned as one object
 *  so both shaders share the exact node instances — and their precise TSL
 *  types flow into buildWaterFieldFragment via `WaterFieldNodes` with no
 *  hand-written annotations. */
export function createWaterFieldNodes(options: WaterFieldMaterialOptions) {
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
  const uRiverShallowColor = uniform(new THREE.Color(0.1, 0.18, 0.3))
  const uRiverMidColor = uniform(new THREE.Color(0.03, 0.09, 0.2))
  const uRiverDeepColor = uniform(new THREE.Color(0.015, 0.035, 0.11))

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
  const cloudTex = texture(getCloudTexture())

  // ── Varyings ──
  const vOrigWorldPos = varying(vec3(0), 'v_origWorldPos')
  const vWorldPos = varying(vec3(0), 'v_worldPos')
  const vWaveHeight = varying(float(0), 'v_waveHeight')
  const vClipPos = varying(vec4(0), 'v_clipPos')
  const vUv = varying(vec2(0), 'v_uv')
  const vBedGrad = varying(vec2(0), 'v_bedGrad')

  const sampleNoise = makeNoiseSampler()

  return {
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
  }
}

export type WaterFieldNodes = ReturnType<typeof createWaterFieldNodes>
