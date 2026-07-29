<script lang="ts">
  // A small sailboat built from primitives (the FishingBobber approach —
  // asset-free v1; a modeled hull is a listed follow-up in doc/BOATS.md).
  // The group follows boatManager's eased transform each frame; userData
  // carries the boat id so canvas clicks can resolve the hull.
  import { onDestroy } from 'svelte'
  import { T, useTask } from '@threlte/core'
  import * as THREE from 'three'
  import { boatManager } from '../managers/boatManager'
  import type { BoatView } from '../stores/boatsStore'

  interface Props {
    boat: BoatView
  }

  let { boat }: Props = $props()

  let group: THREE.Group | undefined = $state()
  let t = $state(0)

  onDestroy(() => boatManager.unregisterMesh(boat.id))

  useTask((delta) => {
    t += delta
    if (!group) return
    const transform = boatManager.transformOf(boat.id)
    if (!transform) return
    // A gentle bob on top of the eased position; the water shader's waves
    // are visual-only, so the hull rides the mean surface (doc/BOATS.md).
    group.position.set(
      transform.x,
      transform.y + Math.sin(t * 1.6) * 0.03,
      transform.z
    )
    group.rotation.y = transform.heading
  })
</script>

<T.Group
  bind:ref={group}
  oncreate={(ref: THREE.Group) => {
    ref.userData.boatId = boat.id
    ref.traverse((child) => {
      child.userData.boatId = boat.id
    })
    boatManager.registerMesh(boat.id, ref)
  }}
>
  <!-- hull: a shallow flared box with a raised bow block -->
  <T.Mesh position={[0, 0.25, 0]}>
    <T.BoxGeometry args={[1.5, 0.5, 3.6]} />
    <T.MeshStandardMaterial color="#7a5230" />
  </T.Mesh>
  <T.Mesh position={[0, 0.42, 1.75]} rotation={[-0.5, 0, 0]}>
    <T.BoxGeometry args={[1.1, 0.45, 0.7]} />
    <T.MeshStandardMaterial color="#6b4728" />
  </T.Mesh>
  <!-- gunwale trim -->
  <T.Mesh position={[0, 0.52, -0.1]}>
    <T.BoxGeometry args={[1.6, 0.08, 3.2]} />
    <T.MeshStandardMaterial color="#5b3d26" />
  </T.Mesh>
  <!-- mast, boom and a slightly filled sail -->
  <T.Mesh position={[0, 1.7, 0.4]}>
    <T.CylinderGeometry args={[0.05, 0.07, 2.6, 8]} />
    <T.MeshStandardMaterial color="#4a3524" />
  </T.Mesh>
  <T.Mesh position={[0.14, 1.9, -0.35]} rotation={[0.08, 0, 0.06]}>
    <T.PlaneGeometry args={[0.02, 1.7]} />
    <T.MeshStandardMaterial color="#4a3524" />
  </T.Mesh>
  <T.Mesh position={[0.1, 1.85, -0.4]} rotation={[0, Math.PI / 2, 0]}>
    <T.PlaneGeometry args={[1.5, 1.6]} />
    <T.MeshStandardMaterial
      color="#f2ede2"
      side={THREE.DoubleSide}
      transparent={false}
    />
  </T.Mesh>
  <!-- tiller at the helm seat -->
  <T.Mesh position={[0, 0.6, -1.55]} rotation={[0.6, 0, 0]}>
    <T.CylinderGeometry args={[0.03, 0.03, 0.6, 6]} />
    <T.MeshStandardMaterial color="#4a3524" />
  </T.Mesh>
</T.Group>
