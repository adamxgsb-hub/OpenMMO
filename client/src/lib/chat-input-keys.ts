export type ChatKeyIntent = 'complete-command' | 'send' | 'none'

/** Keys during IME composition only drive the composition; keyCode 229 covers
 *  browsers that fire IME keydowns without isComposing. Reproduces on macOS
 *  Korean IME only — Windows commits the syllable before dispatching Enter. */
export function chatInputKeyIntent(event: {
  key: string
  isComposing: boolean
  keyCode: number
}): ChatKeyIntent {
  if (event.isComposing || event.keyCode === 229) return 'none'
  if (event.key === 'Tab') return 'complete-command'
  if (event.key !== 'Enter') return 'none'
  return 'send'
}
