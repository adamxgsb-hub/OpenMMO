<script lang="ts">
  import { T } from '@threlte/core'
  import * as THREE from 'three'

  import type { TerrainTile } from './terrain-utils'
  import { TERRAIN_TILE_SIZE, parseTileId } from './terrain-utils'
  import type { TerrainHeightManager } from '../../managers/terrainHeightManager'
  import { RiverFieldManager } from '../../managers/riverFieldManager'
  import {
    createRiverQuadGeometry,
    applyRiverFieldToGeometry,
    buildRiverFieldTexture,
  } from '../../utils/river-quad-geometry'
  import {
    createRiverFieldMaterial,
    type RiverFieldMaterialResult,
  } from '../../shaders/river-field-material'
  import { riverWireframeVisible } from '../../stores/debugStore'

  interface Props {
    terrainTiles: TerrainTile[]
    heightManager: TerrainHeightManager | null
    riverFieldManager: RiverFieldManager | null
    normalMap?: THREE.Texture | null
    reflectionMap?: THREE.Texture | null
    refractionMap?: THREE.Texture | null
    time?: number
    sunDirection?: THREE.Vector3 | null
    sunColor?: THREE.Color | null
    cameraDirection?: THREE.Vector3 | null
    moonBrightness?: number
    torchLight?: THREE.PointLight | null
  }

  let {
    terrainTiles,
    heightManager,
    riverFieldManager,
    normalMap = null,
    reflectionMap = null,
    refractionMap = null,
    time = 0,
    sunDirection = null,
    sunColor = null,
    cameraDirection = null,
    moonBrightness = 0,
    torchLight = null,
  }: Props = $props()

  const riverGroup = new THREE.Group()
  riverGroup.name = 'rivers'

  const wireframeMaterial = new THREE.LineBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false,
  })

  export function getGroup(): THREE.Group {
    return riverGroup
  }

  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const tileMeshes = new Map<string, THREE.Mesh | null>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const tileFieldTextures = new Map<string, THREE.DataTexture>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const wireframeMeshes = new Map<string, THREE.LineSegments>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const inflightTiles = new Set<string>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const tileMaterials = new Map<string, RiverFieldMaterialResult>()

  /** Per-frame uniform sync. Reflection/refraction texture objects are fixed
   *  at material creation time so they do not need per-frame reassignment. */
  export function updateUniforms() {
    for (const result of tileMaterials.values()) {
      const u = result.uniforms
      u.uTime.value = time
      if (sunDirection) u.uSunDirection.value.copy(sunDirection)
      if (sunColor) u.uSunColor.value.copy(sunColor)
      if (cameraDirection) u.uCameraDirection.value.copy(cameraDirection)
      u.uMoonBrightness.value = moonBrightness
      if (torchLight) {
        u.uTorchPos.value.copy(torchLight.position)
        u.uTorchColor.value.copy(torchLight.color)
        u.uTorchIntensity.value = torchLight.intensity
        u.uTorchDistance.value = torchLight.distance
      } else {
        u.uTorchIntensity.value = 0
      }
    }
  }

  function addWireframeForTile(id: string, mesh: THREE.Mesh) {
    if (wireframeMeshes.has(id)) return
    const wf = new THREE.LineSegments(
      new THREE.WireframeGeometry(mesh.geometry),
      wireframeMaterial
    )
    wf.renderOrder = 10
    wf.castShadow = false
    wf.receiveShadow = false
    mesh.add(wf)
    wireframeMeshes.set(id, wf)
  }

  function removeWireframeForTile(id: string) {
    const wf = wireframeMeshes.get(id)
    if (!wf) return
    wf.removeFromParent()
    wf.geometry.dispose()
    wireframeMeshes.delete(id)
  }

  $effect(() => {
    if ($riverWireframeVisible) {
      for (const [id, mesh] of tileMeshes) {
        if (mesh) addWireframeForTile(id, mesh)
      }
    } else {
      for (const id of [...wireframeMeshes.keys()]) {
        removeWireframeForTile(id)
      }
    }
  })

  function disposeTile(id: string) {
    const mesh = tileMeshes.get(id)
    if (mesh) {
      removeWireframeForTile(id)
      riverGroup.remove(mesh)
      mesh.geometry.dispose()
    }
    tileMeshes.delete(id)
    // Field texture is 1:1 with the per-tile material that's discarded
    // alongside it, so disposing here is safe (the Sampler-stale-binding
    // crash applies only to pooled / shared materials).
    const fieldTex = tileFieldTextures.get(id)
    if (fieldTex) fieldTex.dispose()
    tileFieldTextures.delete(id)
    tileMaterials.delete(id)
  }

  async function loadRiverTile(
    id: string,
    tileX: number,
    tileZ: number
  ): Promise<void> {
    if (inflightTiles.has(id) || tileMeshes.has(id)) return
    if (!riverFieldManager || !heightManager || !normalMap || !reflectionMap || !refractionMap) return
    inflightTiles.add(id)
    try {
      const [, field] = await Promise.all([
        heightManager.loadHeightmap(tileX, tileZ).catch(() => null),
        riverFieldManager.loadRiverField(tileX, tileZ),
      ])
      if (!field) {
        tileMeshes.set(id, null)
        return
      }

      const geometry = createRiverQuadGeometry()
      applyRiverFieldToGeometry(geometry, field)

      const fieldTex = buildRiverFieldTexture(field)

      const heightTex = heightManager.getHeightmapTexture(tileX, tileZ)
      if (!heightTex) {
        geometry.dispose()
        fieldTex.dispose()
        return
      }
      tileFieldTextures.set(id, fieldTex)

      const matResult = createRiverFieldMaterial({
        normalMap,
        heightmapTexture: heightTex,
        riverField: fieldTex,
        reflectionMap,
        refractionMap,
      })
      tileMaterials.set(id, matResult)

      const mesh = new THREE.Mesh(geometry, matResult.material)
      mesh.position.set(tileX * TERRAIN_TILE_SIZE, 0, tileZ * TERRAIN_TILE_SIZE)
      mesh.receiveShadow = false
      mesh.castShadow = false
      // Render-after-sea so estuary alpha blending stays stable across
      // the camera frustum (sea uses renderOrder 0, depthWrite off).
      mesh.renderOrder = 1
      riverGroup.add(mesh)
      tileMeshes.set(id, mesh)

      if ($riverWireframeVisible) {
        addWireframeForTile(id, mesh)
      }
    } finally {
      inflightTiles.delete(id)
    }
  }

  $effect(() => {
    if (!riverFieldManager || !heightManager || !normalMap || !reflectionMap || !refractionMap)
      return

    const currentIds = new Set(terrainTiles.map((t) => t.id))
    for (const id of [...tileMeshes.keys()]) {
      if (!currentIds.has(id)) disposeTile(id)
    }
    for (const tile of terrainTiles) {
      const coords = parseTileId(tile.id)
      if (!coords) continue
      void loadRiverTile(tile.id, coords.tileX, coords.tileZ)
    }
  })
</script>

<T is={riverGroup} />
