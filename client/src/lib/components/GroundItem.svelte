<script module lang="ts">
  import * as THREE from 'three'

  // The ground glow is visually identical for every item (only its per-frame
  // opacity/scale pulse varies, and that is a transform, not texture content).
  // Build the texture once and share it across all instances instead of
  // allocating a 256×256 canvas + CanvasTexture per ground item.
  let sharedGlowTexture: THREE.CanvasTexture | undefined

  function getGlowTexture(): THREE.CanvasTexture {
    if (!sharedGlowTexture) sharedGlowTexture = makeGlowTexture()
    return sharedGlowTexture
  }

  function makeGlowTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 256
    const ctx = c.getContext('2d')!

    ctx.save()
    ctx.translate(128, 128)
    ctx.scale(1, 0.34)
    const outer = ctx.createRadialGradient(0, 0, 10, 0, 0, 124)
    outer.addColorStop(0, 'rgba(255, 232, 156, 0.36)')
    outer.addColorStop(0.44, 'rgba(255, 190, 76, 0.16)')
    outer.addColorStop(1, 'rgba(255, 179, 72, 0)')
    ctx.fillStyle = outer
    ctx.fillRect(-128, -380, 256, 760)
    ctx.restore()

    const gradient = ctx.createLinearGradient(20, 0, 236, 0)
    gradient.addColorStop(0, 'rgba(255, 200, 80, 0)')
    gradient.addColorStop(0.18, 'rgba(255, 213, 105, 0.34)')
    gradient.addColorStop(0.5, 'rgba(255, 238, 168, 0.78)')
    gradient.addColorStop(0.82, 'rgba(255, 213, 105, 0.34)')
    gradient.addColorStop(1, 'rgba(255, 200, 80, 0)')

    ctx.filter = 'blur(18px)'
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.roundRect(34, 110, 188, 36, 18)
    ctx.fill()
    ctx.filter = 'none'

    return new THREE.CanvasTexture(c)
  }
</script>

<script lang="ts">
  import { T } from '@threlte/core'
  import { onDestroy } from 'svelte'
  import { getItemDef } from '../data/itemDefs'
  import { getWeaponModelPath } from '../utils/modelPaths'
  import { loadGLB } from '../utils/gltfCache'
  import { localPlayerRightHand } from '../stores/playerHandRegistry'
  import type { TerrainHeightManager } from '../managers/terrainHeightManager'
  import {
    evaluateSpawnAnimation,
    type GroundItemData,
  } from '../managers/groundItemManager'

  interface Props {
    data: GroundItemData
    rotation?: number
    animationTimeMs?: number
    heightManager?: TerrainHeightManager
  }

  let {
    data,
    rotation = 0,
    animationTimeMs = 0,
    heightManager,
  }: Props = $props()

  const def = $derived(getItemDef(data.itemDefId))
  const label = $derived(def?.name ?? data.itemDefId)
  const DEFAULT_GLOW_SHAPE = {
    offsetX: 0,
    offsetY: -0.22,
    offsetZ: 0,
    scaleX: 1.05,
    scaleY: 2.48,
    rotationY: 0,
  }
  const UP = new THREE.Vector3(0, 1, 0)
  const TERRAIN_NORMAL_SAMPLE_DISTANCE = 0.75
  const MAX_TERRAIN_Y_DELTA_FOR_TILT = 0.75

  let worldModelScene: THREE.Object3D | undefined = $state()
  let groundParentRef: THREE.Group | undefined = $state()
  let terrainAlignedRef: THREE.Group | undefined = $state()
  let glowShape = $state(DEFAULT_GLOW_SHAPE)

  function cloneGroundItemScene(scene: THREE.Object3D): THREE.Object3D {
    const clone = scene.clone(true)
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
    return clone
  }

  function getTerrainAlignmentQuaternion(
    worldX: number,
    worldY: number,
    worldZ: number,
    shouldTilt: boolean
  ): THREE.Quaternion {
    if (!shouldTilt || !heightManager?.hasHeightData(worldX, worldZ)) {
      return new THREE.Quaternion()
    }

    const d = TERRAIN_NORMAL_SAMPLE_DISTANCE
    if (
      !heightManager.hasHeightData(worldX - d, worldZ) ||
      !heightManager.hasHeightData(worldX + d, worldZ) ||
      !heightManager.hasHeightData(worldX, worldZ - d) ||
      !heightManager.hasHeightData(worldX, worldZ + d)
    ) {
      return new THREE.Quaternion()
    }

    const terrainY = heightManager.getHeightAtWorldPosition(worldX, worldZ)
    if (Math.abs(worldY - terrainY) > MAX_TERRAIN_Y_DELTA_FOR_TILT) {
      return new THREE.Quaternion()
    }

    const hL = heightManager.getHeightAtWorldPosition(worldX - d, worldZ)
    const hR = heightManager.getHeightAtWorldPosition(worldX + d, worldZ)
    const hB = heightManager.getHeightAtWorldPosition(worldX, worldZ - d)
    const hF = heightManager.getHeightAtWorldPosition(worldX, worldZ + d)
    const normal = new THREE.Vector3(hL - hR, 2 * d, hB - hF).normalize()
    return new THREE.Quaternion().setFromUnitVectors(UP, normal)
  }

  function measureGlowShape(scene: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(scene)
    if (box.isEmpty()) return DEFAULT_GLOW_SHAPE

    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)

    const horizontalLong = Math.max(size.x, size.z, 0.35)
    const horizontalShort = Math.max(Math.min(size.x, size.z), 0.18)
    return {
      offsetX: center.x,
      offsetY: THREE.MathUtils.clamp(box.min.y - 0.04, -0.36, 0.02),
      offsetZ: center.z,
      scaleX: THREE.MathUtils.clamp(horizontalLong * 1.49, 0.83, 2.64),
      scaleY: THREE.MathUtils.clamp(
        Math.max(horizontalShort * 1.35, size.y * 1.4) * 5.5,
        1.87,
        5.78
      ),
      rotationY: size.z > size.x ? Math.PI / 2 : 0,
    }
  }

  $effect(() => {
    const worldModel = def?.worldModel
    if (!worldModel) {
      worldModelScene = undefined
      glowShape = DEFAULT_GLOW_SHAPE
      return
    }
    let cancelled = false
    const path = getWeaponModelPath(worldModel)
    loadGLB(path).then((gltf) => {
      if (cancelled) return
      const scene = cloneGroundItemScene(gltf.scene)
      glowShape = measureGlowShape(scene)
      worldModelScene = scene
    })
    return () => {
      cancelled = true
      const scene = worldModelScene
      if (scene) {
        if (scene.parent) scene.parent.remove(scene)
      }
    }
  })

  $effect(() => {
    const scene = worldModelScene
    const ground = groundParentRef
    if (!scene || !ground) return
    const hand = data.inHand ? $localPlayerRightHand : null
    const targetParent = hand ?? ground
    if (scene.parent === targetParent) return
    scene.position.set(0, hand ? 0.08 : 0, 0)
    scene.rotation.set(0, 0, 0)
    targetParent.add(scene)
  })

  function makeNameTexture(text: string): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 64
    const ctx = c.getContext('2d')!
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.font = 'bold 28px Courier New'
    ctx.fillStyle = '#f0c040'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 128, 32)
    return new THREE.CanvasTexture(c)
  }

  const glowTexture = getGlowTexture()
  const nameTexture = $derived(
    def?.worldModel || worldModelScene ? null : makeNameTexture(label)
  )

  // glowTexture is a shared module-level singleton; never dispose it here.
  onDestroy(() => {
    nameTexture?.dispose()
  })

  const spawnTransform = $derived(
    data.spawnAnimation && !data.inHand
      ? evaluateSpawnAnimation(data.spawnAnimation, animationTimeMs)
      : null
  )
  const displayX = $derived(data.position.x + (spawnTransform?.offsetX ?? 0))
  const displayY = $derived(
    data.position.y + 0.3 + (spawnTransform?.offsetY ?? 0)
  )
  const displayZ = $derived(data.position.z + (spawnTransform?.offsetZ ?? 0))
  const shouldTiltToTerrain = $derived(!data.inHand && !spawnTransform)
  // Depends only on the (post-animation, constant) display position and tilt
  // flag — so a resting item computes its terrain alignment once and stops,
  // rather than re-running terrain height lookups every frame.
  const terrainAlignmentQuaternion = $derived(
    getTerrainAlignmentQuaternion(
      displayX,
      data.position.y,
      displayZ,
      shouldTiltToTerrain
    )
  )
  const glowPulse = $derived(
    0.5 + Math.sin(animationTimeMs * 0.004 + data.instanceId) * 0.5
  )
  const glowOpacity = $derived(0.42 + glowPulse * 0.14)
  const glowScaleX = $derived(glowShape.scaleX * (1 + glowPulse * 0.08))
  const glowScaleY = $derived(glowShape.scaleY * (1 + glowPulse * 0.08))
  const showGlow = $derived(!data.inHand)

  $effect(() => {
    terrainAlignedRef?.quaternion.copy(terrainAlignmentQuaternion)
  })
</script>

<T.Group
  position.x={displayX}
  position.y={displayY}
  position.z={displayZ}
  userData={{ groundItemId: data.instanceId }}
>
  <T.Group bind:ref={terrainAlignedRef}>
    <T.Group
      rotation.y={data.restingRotationY + (worldModelScene || data.spawnAnimation ? 0 : rotation)}
      rotation.z={spawnTransform?.spinZ ?? 0}
    >
      <T.Group bind:ref={groundParentRef} />

      {#if showGlow}
        <T.Group
          position.x={glowShape.offsetX}
          position.y={glowShape.offsetY}
          position.z={glowShape.offsetZ}
          rotation.y={glowShape.rotationY}
        >
          <T.Mesh
            rotation.x={-Math.PI / 2}
            scale={[glowScaleX, glowScaleY, 1]}
            renderOrder={1}
          >
            <T.PlaneGeometry args={[1, 1]} />
            <T.MeshBasicMaterial
              map={glowTexture}
              color="#ffd36a"
              transparent={true}
              opacity={glowOpacity}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </T.Mesh>
        </T.Group>
      {/if}

      {#if !worldModelScene}
        <T.Mesh>
          <T.BoxGeometry args={[0.3, 0.3, 0.3]} />
          <T.MeshStandardMaterial color="#f0c040" />
        </T.Mesh>

        {#if nameTexture}
          <T.Sprite position.y={0.5} scale={[label.length * 0.08, 0.2, 1]}>
            <T.SpriteMaterial map={nameTexture} transparent={true} />
          </T.Sprite>
        {/if}
      {/if}
    </T.Group>
  </T.Group>
</T.Group>
