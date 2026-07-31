<script lang="ts">
  import { T } from '@threlte/core'
  import * as THREE from 'three'
  import type { TerrainTile } from './terrain-utils'
  import { parseTileId } from './terrain-utils'
  import type { TerrainSplatManager } from '../../managers/terrainSplatManager'
  import type { TerrainHeightManager } from '../../managers/terrainHeightManager'
  import { loadGLB } from '../../utils/gltfCache'
  import { enqueueTileWork } from '../../utils/tileWorkQueue'
  import { ore_nodes_for_tile } from '../../wasm/onlinerpg_shared'
  import { depletedOreNodes, oreNodeKeyString } from '../../stores/miningStore'
  import type { OreNodeKey } from '../../network/networkTypes'

  /**
   * Mineable ore outcrops, derived per tile from the baked splatmap +
   * heightmap through the shared wasm (`ore_nodes_for_tile`) — the exact
   * function the server validates `MiningStart` against, so every rendered
   * outcrop is a real vein (doc/MINING.md). The river-rock idiom promoted
   * to gameplay: no extra bake artifact, endpoint, or message.
   *
   * Meshes carry `userData.oreNode` (an `OreNodeKey`) for the click
   * raycast. A vein this client saw crumble renders sunken and dim until
   * its respawn broadcast.
   */

  interface Props {
    terrainTiles: TerrainTile[]
    splatManager?: TerrainSplatManager | null
    heightManager?: TerrainHeightManager | null
  }

  let {
    terrainTiles,
    splatManager = null,
    heightManager = null,
  }: Props = $props()

  const group = new THREE.Group()
  group.name = 'oreNodes'

  export function getGroup(): THREE.Group {
    return group
  }

  /** Fraction of the rock silhouette buried in the slope. */
  const ROCK_SINK = 0.3
  /** A crumbled vein: sunken and dim, still present as a landmark. */
  const DEPLETED_SCALE = 0.45

  interface RockVariant {
    geometry: THREE.BufferGeometry
    material: THREE.Material
    minY: number
    height: number
  }
  let variants: RockVariant[] | null = null
  let variantsPromise: Promise<boolean> | null = null

  /** Every concurrent caller awaits the same load (the river-rock rule). */
  function ensureVariants(): Promise<boolean> {
    variantsPromise ??= (async () => {
      try {
        const urls = [
          '/models/objects/river_rock_01.glb',
          '/models/objects/river_rock_02.glb',
          '/models/objects/river_rock_03.glb',
        ]
        const gltfs = await Promise.all(urls.map((u) => loadGLB(u)))
        variants = gltfs.map((g) => {
          let mesh: THREE.Mesh | null = null
          g.scene.traverse((o) => {
            if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh
          })
          if (!mesh) throw new Error('river_rock glb has no mesh')
          const m = mesh as THREE.Mesh
          m.geometry.computeBoundingBox()
          const bb = m.geometry.boundingBox!
          // Ore-bearing tint over the shared rock texture, so an outcrop
          // reads differently from a plain river rock at a glance.
          const material = (m.material as THREE.Material).clone()
          if (material instanceof THREE.MeshStandardMaterial) {
            material.color = material.color
              .clone()
              .lerp(new THREE.Color('#b98a4f'), 0.35)
          }
          return {
            geometry: m.geometry,
            material,
            minY: bb.min.y,
            height: bb.max.y - bb.min.y,
          }
        })
        return true
      } catch (e) {
        console.error('ore node GLB load failed:', e)
        variantsPromise = null
        return false
      }
    })()
    return variantsPromise
  }

  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const tileGroups = new Map<string, THREE.Group>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const nodeMeshes = new Map<string, THREE.Mesh>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const emptyTiles = new Set<string>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const inflightTiles = new Set<string>()

  function releaseTile(id: string) {
    const tg = tileGroups.get(id)
    if (!tg) return
    for (const child of tg.children) {
      const key = (child.userData.oreNode as OreNodeKey) ?? null
      if (key) nodeMeshes.delete(oreNodeKeyString(key))
    }
    // Geometry is GLTF-cache shared (never dispose); materials are the
    // layer's shared tinted clones.
    group.remove(tg)
    tileGroups.delete(id)
  }

  interface WasmOreNode {
    index: number
    world_x: number
    world_y: number
    world_z: number
    rotation: number
    scale: number
    variant: number
    yield_total: number
  }

  function applyDepletionVisual(mesh: THREE.Mesh, depleted: boolean) {
    const base = mesh.userData.baseScale as number
    mesh.scale.setScalar(depleted ? base * DEPLETED_SCALE : base)
  }

  function activateTile(
    id: string,
    tileX: number,
    tileZ: number,
    nodes: WasmOreNode[]
  ) {
    if (tileGroups.has(id) || !variants) return
    const depleted = $depletedOreNodes
    const tg = new THREE.Group()
    for (const n of nodes) {
      const v = variants[Math.min(n.variant, variants.length - 1)]
      const rock = new THREE.Mesh(v.geometry, v.material)
      const scale = n.scale
      rock.position.set(
        n.world_x,
        n.world_y - v.minY * scale - v.height * scale * ROCK_SINK,
        n.world_z
      )
      rock.scale.setScalar(scale)
      rock.rotation.y = n.rotation
      rock.castShadow = false
      rock.receiveShadow = true
      const key: OreNodeKey = { tile_x: tileX, tile_z: tileZ, index: n.index }
      rock.userData.oreNode = key
      rock.userData.baseScale = scale
      applyDepletionVisual(rock, depleted.has(oreNodeKeyString(key)))
      nodeMeshes.set(oreNodeKeyString(key), rock)
      tg.add(rock)
    }
    group.add(tg)
    tileGroups.set(id, tg)
  }

  async function loadTile(id: string, tileX: number, tileZ: number) {
    if (
      inflightTiles.has(id) ||
      tileGroups.has(id) ||
      emptyTiles.has(id) ||
      !splatManager ||
      !heightManager
    )
      return
    inflightTiles.add(id)
    try {
      const [ok, heights] = await Promise.all([
        ensureVariants(),
        heightManager.loadHeightmap(tileX, tileZ).catch(() => null),
        splatManager.loadSplatmap(tileX, tileZ).catch(() => null),
      ])
      if (!ok || !heights) return // transient — retried on the next pass
      const splat = splatManager.getSplatData(tileX, tileZ)
      if (!splat) return
      let nodes: WasmOreNode[]
      try {
        const heightBytes = new Uint8Array(
          heights.buffer,
          heights.byteOffset,
          heights.length * 2
        )
        nodes = ore_nodes_for_tile(
          tileX,
          tileZ,
          new Uint8Array(splat),
          heightBytes
        ) as WasmOreNode[]
      } catch (e) {
        // Wasm not initialized yet (or malformed tile) — retry later.
        console.warn('ore_nodes_for_tile failed:', e)
        return
      }
      if (nodes.length === 0) {
        emptyTiles.add(id)
        return
      }
      enqueueTileWork(() => activateTile(id, tileX, tileZ, nodes))
    } finally {
      inflightTiles.delete(id)
    }
  }

  $effect(() => {
    if (!splatManager || !heightManager) return
    const currentIds = new Set(terrainTiles.map((t) => t.id))
    for (const id of [...tileGroups.keys()]) {
      if (!currentIds.has(id)) releaseTile(id)
    }
    for (const id of [...emptyTiles]) {
      if (!currentIds.has(id)) emptyTiles.delete(id)
    }
    for (const tile of terrainTiles) {
      const coords = parseTileId(tile.id)
      if (!coords) continue
      void loadTile(tile.id, coords.tileX, coords.tileZ)
    }
  })

  // Depletion broadcasts re-skin the affected meshes.
  $effect(() => {
    const depleted = $depletedOreNodes
    for (const [keyStr, mesh] of nodeMeshes) {
      applyDepletionVisual(mesh, depleted.has(keyStr))
    }
  })
</script>

<T is={group} />
