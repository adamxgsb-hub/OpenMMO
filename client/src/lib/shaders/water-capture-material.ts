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
  clamp,
  max,
  smoothstep,
  length,
  varying,
  positionLocal,
  modelWorldMatrix,
  cameraProjectionMatrix,
  cameraViewMatrix,
} from 'three/tsl'
import { waterHeightFallbackTex, toHeightmapUV } from './water-types'
import { waterFieldFallbackTex } from '../utils/water-quad-geometry'
import { buildShoreMaskNodes, makeNoiseSampler } from './water-shore-waves'

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
  const sampleNoise = makeNoiseSampler()

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
