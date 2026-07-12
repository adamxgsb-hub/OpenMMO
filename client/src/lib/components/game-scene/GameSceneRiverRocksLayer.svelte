<script lang="ts">
  import { T } from '@threlte/core'
  import * as THREE from 'three'
  import type { TerrainTile } from './terrain-utils'
  import { parseTileId } from './terrain-utils'
  import type { WaterFieldManager } from '../../managers/waterFieldManager'
  import type { TerrainHeightManager } from '../../managers/terrainHeightManager'
  import {
    computeRockPlacements,
    filterVisibleRocks,
    VARIANT_HALFWIDTH_RATIO,
    type RiverRockPlacement,
  } from '../../utils/river-rock-placement'
  import { loadGLB } from '../../utils/gltfCache'
  import {
    RiverSpraySystem,
    RiverWakeFoamSystem,
    RiverRockFoamCollars,
    SPRAY_EMIT_RADIUS_M,
    type SprayEmitter,
  } from '../../effects/river-rock-effects'
  import { enqueueTileWork } from '../../utils/tileWorkQueue'

  /**
   * Decorative river rocks derived from the baked turbulence channel:
   * rocks seat shader-rendered downstream foam and spray particles burst
   * from their upstream faces. Pure client-side dressing — no server state.
   */

  interface Props {
    terrainTiles: TerrainTile[]
    waterFieldManager?: WaterFieldManager | null
    heightManager?: TerrainHeightManager | null
    foamMap?: THREE.Texture | null
    sunDirection?: THREE.Vector3 | null
    playerPosition?: { x: number; y: number; z: number } | null
  }

  let {
    terrainTiles,
    waterFieldManager = null,
    heightManager = null,
    foamMap = null,
    sunDirection = null,
    playerPosition = null,
  }: Props = $props()

  const group = new THREE.Group()
  group.name = 'riverRocks'

  export function getGroup(): THREE.Group {
    return group
  }

  /** How deep the rock sits: this fraction of its height is underwater. */
  const ROCK_SINK = 0.38

  // ── Shared resources (lazy) ──
  interface RockVariant {
    geometry: THREE.BufferGeometry
    material: THREE.Material
    minY: number
    height: number
    halfWidth: number
  }
  let variants: RockVariant[] | null = null
  let variantsPromise: Promise<boolean> | null = null
  let spray: RiverSpraySystem | null = null
  let wake: RiverWakeFoamSystem | null = null
  let collars: RiverRockFoamCollars | null = null
  let effectTime = 0

  /** Every concurrent caller awaits the same load — without this, the
   *  tiles that "lose" the first-load race would bail and only retry on
   *  the next tile-list change, leaving foam wakes behind missing rocks
   *  while the player stands still. */
  function ensureVariants(): Promise<boolean> {
    variantsPromise ??= (async () => {
      try {
        const urls = [
          '/models/objects/river_rock_01.glb',
          '/models/objects/river_rock_02.glb',
          '/models/objects/river_rock_03.glb',
        ]
        const gltfs = await Promise.all(urls.map((u) => loadGLB(u)))
        variants = gltfs.map((g, vi) => {
          let mesh: THREE.Mesh | null = null
          g.scene.traverse((o) => {
            if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh
          })
          if (!mesh) throw new Error('river_rock glb has no mesh')
          const m = mesh as THREE.Mesh
          m.geometry.computeBoundingBox()
          const bb = m.geometry.boundingBox!
          const height = bb.max.y - bb.min.y
          const halfWidth =
            Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2
          // Placement (and the water layer's wake mask) uses the baked-in
          // ratio table instead of the GLB — surface drift on re-export.
          if (Math.abs(halfWidth / height - VARIANT_HALFWIDTH_RATIO[vi]) > 0.1)
            console.warn(
              `river_rock_0${vi + 1}.glb halfWidth/height=` +
                `${(halfWidth / height).toFixed(3)} drifted from ` +
                `VARIANT_HALFWIDTH_RATIO[${vi}]=${VARIANT_HALFWIDTH_RATIO[vi]}` +
                ' — update river-rock-placement.ts'
            )
          return {
            geometry: m.geometry,
            material: m.material as THREE.Material,
            minY: bb.min.y,
            height,
            halfWidth,
          }
        })
        return true
      } catch (e) {
        console.error('river rock GLB load failed:', e)
        // Allow the next tile-list pass to retry instead of latching the
        // failure for the session.
        variantsPromise = null
        return false
      }
    })()
    return variantsPromise
  }

  // ── Per-tile state ──
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const tileGroups = new Map<string, THREE.Group>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const tileEmitters = new Map<string, SprayEmitter[]>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const emptyTiles = new Set<string>()
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const inflightTiles = new Set<string>()

  function releaseTile(id: string) {
    const tg = tileGroups.get(id)
    if (tg) {
      // Rocks share GLTF-cache geometry/materials — remove only, never
      // dispose.
      group.remove(tg)
      tileGroups.delete(id)
    }
    tileEmitters.delete(id)
  }

  function activateTile(id: string, placements: RiverRockPlacement[]) {
    if (tileGroups.has(id) || !variants || !foamMap) return

    // Shared effect systems (one pipeline each), created with the first
    // river tile. The collar system must exist before the placement loop
    // — it hands out one mesh per rock.
    if (!spray) {
      spray = new RiverSpraySystem(foamMap)
      group.add(spray.mesh)
    }
    if (!wake) {
      wake = new RiverWakeFoamSystem(foamMap)
      group.add(wake.mesh)
    }
    if (!collars) collars = new RiverRockFoamCollars(foamMap)

    const tg = new THREE.Group()
    const emitters: SprayEmitter[] = []
    for (const p of placements) {
      const v = variants[p.variant]
      const scale = p.height / v.height
      // `p.x/z` is already the final rock centre: placement displaced it
      // downstream of the whitewater impact point so the spray line
      // (0.8 radii upstream of the centre) lands on the impact point.
      // Depth filter and the water layer's wake mask use the same centre.
      const rock = new THREE.Mesh(v.geometry, v.material)
      // Seat the base ROCK_SINK of the silhouette below the surface.
      rock.position.set(
        p.x,
        p.y - p.height * ROCK_SINK - v.minY * scale,
        p.z
      )
      rock.scale.setScalar(scale)
      rock.rotation.y = p.rotY
      rock.castShadow = false
      rock.receiveShadow = false
      tg.add(rock)

      // Teardrop-shaped foam collar: its round head hugs the waterline
      // and its tapered tip follows the downstream flow.
      const collar = collars!.createMesh(
        p.x,
        p.y + 0.03,
        p.z,
        p.halfWidth,
        p.flowX,
        p.flowZ
      )
      tg.add(collar)

      emitters.push({
        x: p.x,
        y: p.y,
        z: p.z,
        flowX: p.flowX,
        flowZ: p.flowZ,
        // The ratio-table half-width, not the GLB's — keeps the spray
        // line on the impact point the placement offset assumed.
        radius: p.halfWidth,
        turb: p.turb,
        speed: p.speed,
        drop: p.surfaceDrop,
        acc: 0,
        wakeAcc: 0,
      })
    }
    group.add(tg)
    tileGroups.set(id, tg)
    tileEmitters.set(id, emitters)
  }

  async function loadTile(id: string, tileX: number, tileZ: number) {
    if (
      inflightTiles.has(id) ||
      tileGroups.has(id) ||
      emptyTiles.has(id) ||
      !waterFieldManager
    )
      return
    inflightTiles.add(id)
    try {
      const hm = heightManager
      const [field, ok, heightsOk] = await Promise.all([
        waterFieldManager.loadWaterField(tileX, tileZ),
        ensureVariants(),
        hm
          ? hm
              .loadHeightmap(tileX, tileZ)
              .then(() => true)
              .catch(() => false)
          : true,
      ])
      if (!ok) return // GLB load failed — not cached, retried on the next tile-list pass
      if (!field) {
        emptyTiles.add(id)
        return
      }
      // Transient heightmap failure: without real bed heights the depth
      // filter would run against bed=0 (rocks on dry banks, or a falsely
      // empty tile cached until it scrolls out). Retry on the next pass.
      if (!heightsOk) return
      const placements = filterVisibleRocks(
        computeRockPlacements(field, tileX, tileZ),
        hm ? (x, z) => hm.getHeightAtWorldPosition(x, z) : null
      )
      if (placements.length === 0) {
        emptyTiles.add(id)
        return
      }
      enqueueTileWork(() => activateTile(id, placements))
    } finally {
      inflightTiles.delete(id)
    }
  }

  $effect(() => {
    if (!waterFieldManager || !foamMap) return
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

  // ── Per-frame ──
  const activeEmitters: SprayEmitter[] = []

  /** Called from GameScene's game loop each frame (deltaTime in ms). */
  export function update(deltaTime: number, camera: THREE.Camera | undefined) {
    const dt = Math.min(deltaTime / 1000, 0.1)

    // Same day/night response as water foam so the spray fades with the
    // downstream foam it decorates.
    const sunY = sunDirection?.y ?? 1
    const t = Math.min(Math.max((sunY + 0.05) / 0.15, 0), 1)
    const dayDim = 0.1 + 0.9 * (t * t * (3 - 2 * t))
    if (!camera || !spray || !wake || !collars) return
    effectTime += dt
    spray.setDayDim(dayDim)
    wake.setDayDim(dayDim)
    collars.setDayDim(dayDim)
    collars.setTime(effectTime)
    activeEmitters.length = 0
    if (playerPosition) {
      const r2 = SPRAY_EMIT_RADIUS_M * SPRAY_EMIT_RADIUS_M
      for (const emitters of tileEmitters.values()) {
        for (const e of emitters) {
          const dx = e.x - playerPosition.x
          const dz = e.z - playerPosition.z
          if (dx * dx + dz * dz < r2) activeEmitters.push(e)
          else {
            e.acc = 0
            e.wakeAcc = 0
          }
        }
      }
    }
    spray.update(dt, camera, activeEmitters)
    wake.update(dt, activeEmitters)
  }
</script>

<T is={group} />
