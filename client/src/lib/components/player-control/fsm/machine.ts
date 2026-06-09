import type { PlayerControlEvent, PlayerControlUpdateOptions } from './events'
import type { PlayerControlStateName } from './control-state'
import type { PlayerControlStateDefinitions } from './state-definitions'

export interface PlayerControlMachineHandlers {
  dispatchEvent: (event: PlayerControlEvent) => void
  getStateName: () => PlayerControlStateName
}

export interface PlayerControlMachineOptions {
  states?: PlayerControlStateDefinitions
}

export class PlayerControlMachine {
  private queuedEvents: PlayerControlEvent[] = []
  private disposed = false
  private currentStateName: PlayerControlStateName

  constructor(
    private readonly handlers: PlayerControlMachineHandlers,
    private readonly options: PlayerControlMachineOptions = {}
  ) {
    this.currentStateName = handlers.getStateName()
    this.enterState(this.currentStateName)
  }

  get stateName() {
    return this.currentStateName
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

  private setObservedStateName(nextStateName: PlayerControlStateName) {
    if (nextStateName === this.currentStateName) return

    this.exitState(this.currentStateName)
    this.currentStateName = nextStateName
    this.enterState(nextStateName)
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

  private refreshObservedStateName() {
    this.setObservedStateName(this.handlers.getStateName())
  }

  private dispatchEvent(event: PlayerControlEvent) {
    const consumed = this.currentState?.handleEvent?.(event) === true
    if (!consumed) {
      this.handlers.dispatchEvent(event)
    }
    this.refreshObservedStateName()
  }

  private handleInteractKey() {
    this.currentState?.handleInteractKey?.()
    this.refreshObservedStateName()
  }

  private handleKeyboard() {
    this.currentState?.handleKeyboard?.()
    this.refreshObservedStateName()
  }

  private tick(deltaTime: number) {
    this.currentState?.tick?.(deltaTime)
    this.refreshObservedStateName()
  }
}
