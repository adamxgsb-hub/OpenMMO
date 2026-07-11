<script lang="ts" module>
  // Fed each frame from GameScene's loop with the same clock the water
  // material's uTime uses, so the readout matches the shader exactly.
  let waterT = $state(0)
  export function tickWavePhase(time: number) {
    waterT = time
  }
</script>

<script lang="ts">
  import { shoreWaveDebugVisible } from '../stores/debugStore'
  import { SHORE_WAVE_TIMING as T } from '../shaders/shore-wave-timing'
  import { smoothstep } from '../terrain/terrain-constants'

  // Cycle fraction where breaking starts (inverse of the move-space
  // smoothstep window, solved once by bisection).
  function invSmoothstep(y: number) {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2
      if (mid * mid * (3 - 2 * mid) < y) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  const brkStartCycle = invSmoothstep(T.brkStartMove) * T.moveEnd
  const brkEndCycle = invSmoothstep(T.brkEndMove) * T.moveEnd

  // Consecutive stage windows over the cycle; each stage ends where the
  // next begins, so only the end is stored.
  const STAGES: Array<{ stage: string; end: number; color: string }> = [
    { stage: 'RUN-IN', end: brkStartCycle, color: '#8fd3ff' },
    { stage: 'BREAK', end: brkEndCycle, color: '#ffd75e' },
    { stage: 'BORE', end: T.runupStart, color: '#ffb45e' },
    { stage: 'RUN-UP', end: T.runupEnd, color: '#ffffff' },
    { stage: 'PEAK', end: T.flushStart, color: '#c0ffc0' },
    { stage: 'FLUSH', end: T.flushEnd, color: '#ff9e9e' },
    { stage: 'BACKWASH', end: T.recedeEnd, color: '#c9a0ff' },
    { stage: 'DRAINED', end: 1, color: '#9e9e9e' },
  ]

  function describe(offset: number) {
    const cycle = (waterT * T.speed + offset) % 1
    const move = smoothstep(0, T.moveEnd, cycle)
    let i = 0
    let start = 0
    while (i < STAGES.length - 1 && cycle >= STAGES[i].end) {
      start = STAGES[i].end
      i++
    }
    const { stage, end, color } = STAGES[i]
    // RUN-IN / BREAK progress runs in move space (matching the shader's
    // eased crest travel); the rest is linear in cycle.
    const prog =
      stage === 'RUN-IN'
        ? move
        : stage === 'BREAK'
          ? smoothstep(T.brkStartMove, T.brkEndMove, move)
          : (cycle - start) / (end - start)
    return { cycle, move, stage, color, prog }
  }

  const phases = $derived([
    { name: 'A', p: describe(0) },
    { name: 'B', p: describe(0.5) },
  ])
</script>

{#if $shoreWaveDebugVisible}
  <div class="wave-debug">
    <div class="title">SHORE WAVE</div>
    {#each phases as { name, p } (name)}
      <div class="row">
        <span class="name">{name}</span>
        <span class="cycle">{p.cycle.toFixed(3)}</span>
        <span class="stage" style="color: {p.color}"
          >{p.stage} {Math.round(p.prog * 100)}%</span
        >
        <span class="move">mv {Math.round(p.move * 100)}%</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .wave-debug {
    position: fixed;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1000;
    background: rgba(0, 0, 0, 0.75);
    color: #00ff00;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid rgba(0, 255, 0, 0.3);
    font-family: 'Courier New', monospace;
    font-size: 12px;
    font-weight: bold;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    color: #7fdfff;
    font-size: 10px;
    letter-spacing: 1px;
  }

  .row {
    display: flex;
    gap: 8px;
    white-space: nowrap;
  }

  .name {
    color: #e2b93b;
  }

  .stage {
    min-width: 110px;
  }

  .move {
    color: #9adf9a;
  }
</style>
