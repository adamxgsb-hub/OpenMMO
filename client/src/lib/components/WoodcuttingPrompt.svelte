<script lang="ts">
  // Local player's chopping HUD. There is nothing to answer — the server
  // swings on its own clock — so this is a progress readout plus ESC to
  // stop. The bar animates between swings cosmetically; the authoritative
  // timer is server-side.
  import { myChopPhase, myChopProgress } from '../stores/woodcuttingStore'
  import { networkManager } from '../network/socket'

  let swingPct = $state(0)
  let raf: number | null = null

  $effect(() => {
    const progress = $myChopProgress
    if (!progress) {
      swingPct = 0
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
      return
    }
    const tick = () => {
      const elapsed = performance.now() - progress.startedAt
      const withinSwing = Math.min(1, elapsed / progress.swingMs)
      swingPct =
        ((progress.swingsDone + withinSwing) / progress.swingsNeeded) * 100
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
    }
  })

  function onKeydown(event: KeyboardEvent) {
    if ($myChopPhase === 'idle') return
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    if (event.code === 'Escape') {
      event.preventDefault()
      networkManager.sendChopStop()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if $myChopPhase === 'chopping' && $myChopProgress}
  {@const p = $myChopProgress}
  <div class="chop-panel">
    <div class="chop-header">
      <span class="chop-label">Chopping…</span>
      <span class="chop-count">{p.swingsDone}/{p.swingsNeeded} swings</span>
    </div>
    <div
      class="chop-track"
      role="progressbar"
      aria-label="Chopping progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(swingPct)}
    >
      <span class="chop-fill" style={`width: ${Math.min(100, swingPct)}%`}
      ></span>
    </div>
    <div class="chop-hint">ESC to stop</div>
  </div>
{/if}

<style>
  .chop-panel {
    position: fixed;
    left: 50%;
    bottom: 20%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(280px, 80vw);
    padding: 12px 16px;
    border-radius: 12px;
    background: rgba(6, 10, 14, 0.88);
    border: 1px solid rgba(166, 200, 238, 0.35);
    z-index: 30;
  }

  .chop-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .chop-label {
    color: #e6edf3;
    font-size: 14px;
    font-weight: 700;
  }

  .chop-count {
    color: rgba(166, 200, 238, 0.9);
    font-size: 13px;
    white-space: nowrap;
  }

  .chop-track {
    position: relative;
    height: 8px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(64, 98, 135, 0.45);
    border: 1px solid rgba(166, 200, 238, 0.25);
  }

  .chop-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(90deg, #8a5a2b 0%, #e8c34f 100%);
    transition: width 0.1s linear;
  }

  .chop-hint {
    color: rgba(166, 200, 238, 0.7);
    font-size: 11px;
    text-align: center;
  }
</style>
