<script lang="ts">
  // The rowboat hull (doc/BOATS.md art pass, Meshy-generated). The GLB is
  // normalized at load — scaled to the 3.6 m hull the seat offsets assume,
  // centred, with a little draft below the waterline — so the model can be
  // regenerated without touching code. The group follows boatManager's
  // eased transform each frame; userData carries the boat id so canvas
  // clicks can resolve the hull.
  import { onDestroy } from 'svelte'
  import { T, useTask } from '@threlte/core'
  import * as THREE from 'three'
  import { boatManager } from '../managers/boatManager'
  import { loadGLB } from '../utils/gltfCache'
  import { getObjectModelPath } from '../utils/modelPaths'
  import type { BoatView } from '../stores/boatsStore'

  interface Props {
    boat: BoatView
  }

  let { boat }: Props = $props()

  /** Matches the seat-offset footprint in boat-transform.ts. */
  const HULL_LENGTH_M = 3.6
  /** Fraction of the hull's height sitting under the waterline. */
  const DRAFT_FRACTION = 0.18

  let group: THREE.Group | undefined = $state()
  let t = $state(0)

  onDestroy(() => boatManager.unregisterMesh(boat.id))

  async function attachHull(root: THREE.Group) {
    const gltf = await loadGLB(getObjectModelPath('objects/rowboat.glb'))
    const hull = gltf.scene.clone(true)
    const inner = new THREE.Group()
    inner.add(hull)
    // Long axis to Z (heading 0 faces +Z), then fit and seat on the water.
    const raw = new THREE.Box3().setFromObject(hull)
    const rawSize = raw.getSize(new THREE.Vector3())
    if (rawSize.x > rawSize.z) hull.rotation.y = Math.PI / 2
    const box = new THREE.Box3().setFromObject(inner)
    const size = box.getSize(new THREE.Vector3())
    const scale = HULL_LENGTH_M / Math.max(size.x, size.z)
    inner.scale.setScalar(scale)
    const scaled = new THREE.Box3().setFromObject(inner)
    const center = scaled.getCenter(new THREE.Vector3())
    const height = scaled.max.y - scaled.min.y
    inner.position.set(
      -center.x,
      -scaled.min.y - height * DRAFT_FRACTION,
      -center.z
    )
    root.add(inner)
    root.userData.boatId = boat.id
    root.traverse((child) => {
      child.userData.boatId = boat.id
    })
    boatManager.registerMesh(boat.id, root)
  }

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
    void attachHull(ref)
  }}
></T.Group>
