import * as THREE from 'three'
import {
  createTerrainGeometry,
  TERRAIN_TILE_SIZE,
  SEA_LEVEL,
} from '../components/game-scene/terrain-utils'
import { WATER_FIELD_GRID, type WaterFieldTileData } from './water-field-data'

/** 65×65 flat-quad geometry covering one tile, ready for vertex Y to be
 *  driven by a baked `surfaceY` field via {@link applyWaterFieldToGeometry}.
 *  Layout matches the terrain geometry so heightmap UVs line up. */
export function createWaterQuadGeometry(): THREE.BufferGeometry {
  return createTerrainGeometry(TERRAIN_TILE_SIZE, WATER_FIELD_GRID - 1)
}

/** Copy `surfaceY` row-major into vertex Y, then refresh the bounding
 *  sphere so isometric raycasts don't early-reject elevated meshes
 *  (same fix `applyHeightToGeometry` applies to terrain). */
export function applyWaterFieldToGeometry(
  geometry: THREE.BufferGeometry,
  field: WaterFieldTileData
): void {
  const G = WATER_FIELD_GRID
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  const positions = posAttr.array as Float32Array
  for (let vz = 0; vz < G; vz++) {
    const row = vz * G
    for (let vx = 0; vx < G; vx++) {
      positions[(row + vx) * 3 + 1] = field.surfaceY[row + vx]
    }
  }
  posAttr.needsUpdate = true
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
}

/** Build a 65×65 RGBA32F DataTexture from a decoded water field. R =
 *  surfaceY (m), GB = downstream flow vector (magnitude = baked speed),
 *  A = riverness. flipY matches the heightmap so `toHeightmapUV(uv())`
 *  works for both. */
export function buildWaterFieldTexture(
  data: WaterFieldTileData
): THREE.DataTexture {
  const W = WATER_FIELD_GRID
  const buf = new Float32Array(W * W * 4)
  for (let i = 0; i < W * W; i++) {
    buf[i * 4 + 0] = data.surfaceY[i]
    buf[i * 4 + 1] = data.flowX[i]
    buf[i * 4 + 2] = data.flowZ[i]
    buf[i * 4 + 3] = data.riverness[i]
  }
  const tex = new THREE.DataTexture(
    buf,
    W,
    W,
    THREE.RGBAFormat,
    THREE.FloatType
  )
  tex.flipY = true
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/** Water-field fallback texture (RGBA32F): flat sea at `SEA_LEVEL`, no
 *  flow, riverness 0. Doubles as (a) the field for sea-only tiles that
 *  have no baked WFD file, and (b) the pooled-material reset value —
 *  format must match what the field TextureNode was compiled with, or
 *  WebGPU bind groups fail (same constraint as `waterHeightFallbackTex`).
 *  Constant-valued, so bilinear filtering across the 1×1 texel is safe. */
export const waterFieldFallbackTex = new THREE.DataTexture(
  new Float32Array([SEA_LEVEL, 0, 0, 0]),
  1,
  1,
  THREE.RGBAFormat,
  THREE.FloatType
)
waterFieldFallbackTex.needsUpdate = true

/** Shared flat 65×65 quad at `SEA_LEVEL` for sea-only tiles (no WFD
 *  file). One module-level instance — never dispose per tile. */
let _seaGeometry: THREE.BufferGeometry | null = null
export function getSharedSeaGeometry(): THREE.BufferGeometry {
  if (!_seaGeometry) {
    _seaGeometry = createWaterQuadGeometry()
    if (SEA_LEVEL !== 0) {
      const posAttr = _seaGeometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute
      const positions = posAttr.array as Float32Array
      for (let i = 0; i < positions.length; i += 3) positions[i + 1] = SEA_LEVEL
      posAttr.needsUpdate = true
    }
    _seaGeometry.computeBoundingSphere()
    _seaGeometry.computeBoundingBox()
  }
  return _seaGeometry
}
