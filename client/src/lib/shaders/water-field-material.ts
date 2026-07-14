import * as THREE from 'three'
import { NodeMaterial } from 'three/webgpu'
import {
  Fn,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  pow,
  smoothstep,
  max,
  length,
  positionLocal,
  modelWorldMatrix,
  cameraProjectionMatrix,
  cameraViewMatrix,
} from 'three/tsl'
import { gerstnerWave } from './gerstner'
import { toHeightmapUV } from './water-types'
import {
  buildNoisyDepth,
  buildShoreWavePhase,
  buildSwell,
} from './water-shore-waves'
import {
  createWaterFieldNodes,
  type WaterFieldMaterialOptions,
} from './water-field-nodes'
import { buildWaterFieldFragment } from './water-field-fragment'

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

export function createWaterFieldMaterial(
  options: WaterFieldMaterialOptions
): WaterFieldMaterialResult {
  const nodes = createWaterFieldNodes(options)
  const {
    uTime,
    uWaveA,
    uWaveB,
    uWaveC,
    heightmapTex,
    waterFieldTex,
    vUv,
    vOrigWorldPos,
    vWorldPos,
    vWaveHeight,
    vClipPos,
    vBedGrad,
    sampleNoise,
  } = nodes

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
    // Bed gradient for the fragment swell normal. The heightmap is static
    // (65 texels over 64 m ⇒ ~1 m per texel), so central differences are
    // per-vertex work, not per-fragment fetches. +v is −z in world
    // (PlaneGeometry uv under rotateX(-π/2)).
    const HM_TEXEL = float(1.0 / 65.0)
    vBedGrad.assign(
      vec2(
        heightmapTex
          .sample(hUV.add(vec2(HM_TEXEL, 0)))
          .r.sub(heightmapTex.sample(hUV.sub(vec2(HM_TEXEL, 0))).r),
        heightmapTex
          .sample(hUV.sub(vec2(0, HM_TEXEL)))
          .r.sub(heightmapTex.sample(hUV.add(vec2(0, HM_TEXEL))).r)
      ).mul(0.5)
    )
    const vtxTerrainH = heightmapTex.sample(hUV).r
    const vtxField = waterFieldTex.sample(hUV)
    const vtxRiverness = vtxField.a
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

    // Shore swell: traveling breaker humps in the shallow band the
    // Gerstner damping just flattened — same phases/coordinate as the
    // fragment foam so the whitecap sits on the geometric crest. Gated
    // like seaFxGate: no swell inside rivers or across the estuary.
    const vtxSeaness = float(1).sub(vtxRiverness)
    const vtxSwellGate = vtxSeaness
      .mul(vtxSeaness)
      .mul(
        float(1).sub(smoothstep(float(0.02), float(0.2), length(vtxField.gb)))
      )
    const vtxPhaseA = buildShoreWavePhase(uTime, 0)
    const vtxPhaseB = buildShoreWavePhase(uTime, 0.5)
    const vtxNoisyDA = buildNoisyDepth(
      vtxDepth,
      p.xz,
      vtxPhaseA.seed,
      sampleNoise
    )
    const vtxNoisyDB = buildNoisyDepth(
      vtxDepth,
      p.xz,
      vtxPhaseB.seed,
      sampleNoise
    )
    const swellY = buildSwell(vtxNoisyDA, vtxDepth, vtxPhaseA)
      .height.add(buildSwell(vtxNoisyDB, vtxDepth, vtxPhaseB).height)
      .mul(vtxSwellGate)
    offset.addAssign(vec3(0, swellY, 0))

    worldPos.xyz.addAssign(offset)
    vWaveHeight.assign(offset.y)
    vWorldPos.assign(worldPos.xyz)

    const clipPos = cameraProjectionMatrix.mul(cameraViewMatrix).mul(worldPos)
    vClipPos.assign(clipPos)

    return clipPos
  })()

  const fragmentNode = buildWaterFieldFragment(nodes)

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
      uTime: nodes.uTime,
      uSunDirection: nodes.uSunDirection,
      uSunColor: nodes.uSunColor,
      uCameraDirection: nodes.uCameraDirection,
      uMoonBrightness: nodes.uMoonBrightness,
      uTorchPos: nodes.uTorchPos,
      uTorchColor: nodes.uTorchColor,
      uTorchIntensity: nodes.uTorchIntensity,
      uTorchDistance: nodes.uTorchDistance,
      uRefractionMap: nodes.refractionTex,
      uReflectionMap: nodes.reflectionTex,
      uHeightmapTexture: nodes.heightmapTex,
      uWaterField: nodes.waterFieldTex,
      uNormalMap: nodes.normalMapTex,
      uFoamMap: nodes.foamMapTex,
      uCausticsMap: nodes.causticsTex,
      uWetnessMap: nodes.wetnessMapTex,
      uWaveA: nodes.uWaveA,
      uWaveB: nodes.uWaveB,
      uWaveC: nodes.uWaveC,
    },
  }
}

export { SWELL_SPAWN_DEPTH, SWELL_SHORE_DEPTH } from './water-shore-waves'
export {
  getWaterCaptureMaterial,
  type WaterCaptureMaterialResult,
} from './water-capture-material'
export type { WaterFieldMaterialOptions } from './water-field-nodes'
