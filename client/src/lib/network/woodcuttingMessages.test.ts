import { describe, expect, it } from 'vitest'
import { fellMessage } from './woodcuttingMessages'

// The wording contract with the player: name the timber by its display name
// and count the haul. Cross-reference: agent-client/src/driver/prompt.rs
// felled_line carries the same information to an LLM.

describe('fellMessage', () => {
  it('names a single log in the singular', () => {
    expect(fellMessage({ name: 'Timber Log' }, 'timber_log', 1)).toBe(
      'The tree falls — you cut a Timber Log.'
    )
  })

  it('counts a multi-log haul', () => {
    expect(fellMessage({ name: 'Oak Log' }, 'oak_log', 4)).toBe(
      'The tree falls — you cut 4 Oak Logs.'
    )
  })

  it('falls back to the item id when the def is unknown', () => {
    expect(fellMessage(undefined, 'oak_log', 2)).toContain('oak_log')
  })
})
