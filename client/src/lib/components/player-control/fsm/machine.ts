import type { PlayerControlEvent, PlayerControlUpdateOptions } from './events'
import type { PlayerControlStateName } from './control-state'
import type { PlayerControlStateDefinitions } from './state-definitions'

export interface PlayerControlMachineHandlers {
  dispatchEvent: (event: PlayerControlEvent) => void
}

export interface PlayerControlMachineOptions {
  states?: PlayerControlStateDefinitions
  initialStateName?: PlayerControlStateName
}

export class PlayerControlMachine {
  private queuedEvents: PlayerControlEvent[] = []
  private disposed = false
  private currentStateName: PlayerControlStateName

  constructor(
    private readonly handlers: PlayerControlMachineHandlers,
    private readonly options: PlayerControlMachineOptions = {}
  ) {
    this.currentStateName = options.initialStateName ?? 'idle'
    this.enterState(this.currentStateName)
  }

  get stateName() {
    return this.currentStateName
  }

  /**
   * Explicit state transition. The machine OWNS its current state: it changes
   * only through this method, never by polling/deriving a name from external
   * flags. Callers transition at the actual decision points (move start,
   * arrival, attack, interact enter/exit, dead/respawn, jump). A transition to
   * the state we are already in is a no-op (no exit/enter re-fire).
   */
  transition(nextStateName: PlayerControlStateName) {
    if (this.disposed) return
    if (nextStateName === this.currentStateName) return
    this.exitState(this.currentStateName)
    this.currentStateName = nextStateName
    this.enterState(nextStateName)
  }

  enqueueEvent(event: PlayerControlEvent) {
    if (this.disposed) return
    this.queuedEvents.push(event)
  }

  update(deltaTime: number, options: PlayerControlUpdateOptions) {
    if (this.disposed) return

    const events = this.queuedEvents
    this.queuedEvents = []

    for (const event of events) {
      this.dispatchEvent(event)
    }
    if (options.events) {
      for (const event of options.events) {
        this.dispatchEvent(event)
      }
    }

    if (!options.editorMode) {
      this.handleInteractKey()
      this.handleKeyboard()
    }

    this.tick(deltaTime)
  }

  dispose() {
    if (this.disposed) return
    this.exitState(this.currentStateName)
    this.disposed = true
    this.queuedEvents = []
  }

  private enterState(stateName: PlayerControlStateName) {
    this.options.states?.[stateName]?.enter?.()
  }

  private exitState(stateName: PlayerControlStateName) {
    this.options.states?.[stateName]?.exit?.()
  }

  private get currentState() {
    return this.options.states?.[this.currentStateName]
  }

  private dispatchEvent(event: PlayerControlEvent) {
    const consumed = this.currentState?.handleEvent?.(event) === true
    if (!consumed) {
      this.handlers.dispatchEvent(event)
    }
  }

  private handleInteractKey() {
    this.currentState?.handleInteractKey?.()
  }

  private handleKeyboard() {
    this.currentState?.handleKeyboard?.()
  }

  private tick(deltaTime: number) {
    this.currentState?.tick?.(deltaTime)
  }
}
