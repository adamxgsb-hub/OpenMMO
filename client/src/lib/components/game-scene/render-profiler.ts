import type * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'

export type RenderTag = 'main' | 'refraction' | 'reflection' | 'wetness'

const TAGS: readonly RenderTag[] = [
  'main',
  'refraction',
  'reflection',
  'wetness',
]

function emptyCounters(): Record<RenderTag, number> {
  return { main: 0, refraction: 0, reflection: 0, wetness: 0 }
}

export interface RenderProfiler {
  /** Set the active tag for renders that follow until the next setTag. */
  setTag(tag: RenderTag): void
  /** Run `fn` with `tag` active, then restore the tag to 'main'. */
  withTag(tag: RenderTag, fn: () => void): void
  wrap(renderer: WebGPURenderer): void
  resetFrame(): void
  readonly ms: Record<RenderTag, number>
  readonly drawCalls: Record<RenderTag, number>
  readonly triangles: Record<RenderTag, number>
  readonly renderCalls: Record<RenderTag, number>
}

export function createRenderProfiler(isEnabled: () => boolean): RenderProfiler {
  let currentTag: RenderTag = 'main'
  const ms = emptyCounters()
  const drawCalls = emptyCounters()
  const triangles = emptyCounters()
  const renderCalls = emptyCounters()
  let wrapped = false

  return {
    setTag(tag) {
      currentTag = tag
    },
    withTag(tag, fn) {
      currentTag = tag
      try {
        fn()
      } finally {
        currentTag = 'main'
      }
    },
    wrap(renderer) {
      if (wrapped) return
      wrapped = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = renderer as any
      const origRender = r.render.bind(r)
      r.render = (scene: THREE.Scene, cam: THREE.Camera) => {
        if (!isEnabled()) {
          origRender(scene, cam)
          return
        }
        // `info.render.drawCalls` accumulates per rAF frame (reset by Animation
        // auto-reset), so take a delta around this single render() call to get
        // the per-call draw count. `info.render.calls` is cumulative since app
        // start and is NOT reset per render — don't use it.
        const infoRender = r.info?.render
        const drawsBefore = infoRender?.drawCalls ?? 0
        const trisBefore = infoRender?.triangles ?? 0
        const start = performance.now()
        origRender(scene, cam)
        const elapsed = performance.now() - start
        const drawsAfter = infoRender?.drawCalls ?? 0
        const trisAfter = infoRender?.triangles ?? 0
        ms[currentTag] += elapsed
        renderCalls[currentTag] += 1
        drawCalls[currentTag] += drawsAfter - drawsBefore
        triangles[currentTag] += trisAfter - trisBefore
      }
    },
    resetFrame() {
      for (const t of TAGS) {
        ms[t] = 0
        drawCalls[t] = 0
        triangles[t] = 0
        renderCalls[t] = 0
      }
    },
    ms,
    drawCalls,
    triangles,
    renderCalls,
  }
}
