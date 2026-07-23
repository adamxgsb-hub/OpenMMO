import { describe, it, expect } from 'vitest'
import { qualityForScore } from './graphicsSettings'

describe('qualityForScore', () => {
  it('maps descending scores to descending presets', () => {
    expect(qualityForScore(600)).toBe('high')
    expect(qualityForScore(599)).toBe('medium')
    expect(qualityForScore(70)).toBe('medium')
    expect(qualityForScore(69)).toBe('low')
    expect(qualityForScore(0)).toBe('low')
  })

  it('classifies the measured hardware anchors', () => {
    // RTX 4090 ~1730 (±8%), M3 10-core ~92 (±1.5%). Both should stay put
    // across their whole observed spread.
    expect(qualityForScore(1590)).toBe('high')
    expect(qualityForScore(2033)).toBe('high')
    expect(qualityForScore(91.8)).toBe('medium')
    expect(qualityForScore(93.2)).toBe('medium')
  })

  it('never returns a level above medium for an implausible score', () => {
    expect(qualityForScore(-1)).toBe('low')
    expect(qualityForScore(Number.NaN)).toBe('low')
  })
})
