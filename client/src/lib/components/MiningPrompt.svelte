<script lang="ts">
  // The local player's mining HUD: a status pill while the server swings
  // the pick. There is nothing to time or answer — strikes resolve
  // server-side and land in the combat log — so the only control is ESC
  // (or moving away) to stop. Self-contained window listener (the
  // FishingPrompt dialog pattern) so the player-control FSM stays
  // untouched.
  import { myMiningPhase } from '../stores/miningStore'
  import { networkManager } from '../network/socket'

  function onKeydown(event: KeyboardEvent) {
    if ($myMiningPhase === 'idle') return
    if (event.code === 'Escape') {
      event.preventDefault()
      networkManager.sendMiningStop()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if $myMiningPhase === 'mining'}
  <div class="mining-prompt">Mining the vein… ESC or step away to stop</div>
{/if}

<style>
  .mining-prompt {
    position: fixed;
    left: 50%;
    bottom: 22%;
    transform: translateX(-50%);
    padding: 8px 18px;
    border-radius: 999px;
    font-size: 15px;
    pointer-events: none;
    z-index: 30;
    background: rgba(38, 28, 12, 0.78);
    color: #eec99a;
    border: 1px solid rgba(238, 201, 154, 0.35);
    animation: mining-throb 1.4s ease-in-out infinite alternate;
  }

  @keyframes mining-throb {
    from {
      filter: brightness(1);
    }
    to {
      filter: brightness(1.25);
    }
  }
</style>
