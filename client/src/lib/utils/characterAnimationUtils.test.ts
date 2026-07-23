import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { computeCorpseGroundOffset } from './characterAnimationUtils'

// A one-bone skinned mesh whose vertices sit at the given local Ys, all fully
// weighted to the bone. `posedBoneY` moves the bone AFTER bind, standing in for
// a death clip that poses the skeleton away from its rest pose.
function makeSkinned(localYs: number[], posedBoneY = 0): THREE.Group {
  const n = localYs.length
  const positions = new Float32Array(n * 3)
  const skinIndex = new Uint16Array(n * 4)
  const skinWeight = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 1] = localYs[i]
    skinWeight[i * 4] = 1
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
  geom.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(skinWeight, 4)
  )

  const bone = new THREE.Bone()
  const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshBasicMaterial())
  mesh.add(bone)
  mesh.bind(new THREE.Skeleton([bone]))

  const root = new THREE.Group()
  root.add(mesh)
  bone.position.y = posedBoneY
  root.updateMatrixWorld(true)
  return root
}

const CLEARANCE = 0.01

describe('computeCorpseGroundOffset', () => {
  it('grounds the body and ignores a few outlier vertices', () => {
    // Body at 0.30 m; one stray vertex dangling to -0.50 m (like a tail tip).
    // A min-based offset would LIFT the body by +0.51; the percentile must
    // instead DROP the body ~0.29 so it rests, letting the outlier go below.
    const body = new Array(100).fill(0.3)
    const root = makeSkinned([-0.5, ...body])
    const offset = computeCorpseGroundOffset(root)
    expect(offset).toBeCloseTo(-0.3 + CLEARANCE, 5)
  })

  it('rests a uniformly-raised corpse on the floor', () => {
    const root = makeSkinned(new Array(100).fill(0.25))
    expect(computeCorpseGroundOffset(root)).toBeCloseTo(-0.25 + CLEARANCE, 5)
  })

  it('measures the current pose, not the bind pose', () => {
    const flat = new Array(100).fill(0.2)
    const rest = computeCorpseGroundOffset(makeSkinned(flat, 0))
    const posed = computeCorpseGroundOffset(makeSkinned(flat, 0.5))
    expect(posed).toBeCloseTo(rest - 0.5, 5)
  })

  it('returns 0 when there is no skinned geometry', () => {
    const root = new THREE.Group()
    root.add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    )
    expect(computeCorpseGroundOffset(root)).toBe(0)
  })
})
