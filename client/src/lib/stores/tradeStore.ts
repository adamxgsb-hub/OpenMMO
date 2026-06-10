import { writable } from 'svelte/store'

/** An open shop session with a merchant NPC, driven by ServerMessage::ShopState.
 *  Set to a session to open the trade window, to null to close it. */
export interface ShopSession {
  merchantPlayerId: string
  merchantName: string
  catalog: string[]
  sellRatePercent: number
}

export const shopSession = writable<ShopSession | null>(null)

/** Which side of a trade a haggled deal applies to (mirrors DealKind). */
export type DealKind = 'buy' | 'sell'

/** A haggled price modifier granted by an LLM NPC (economy phase 2).
 *  Single-use: the server consumes it on the first traded unit. */
export interface ShopDeal {
  /** Percentage points added to the normal price (negative = buy discount,
   *  positive = sell bonus). */
  modifierPct: number
  /** Epoch ms when the deal lapses (server enforces the real expiry). */
  expiresAt: number
}

/** Active deals keyed by `dealKey(...)`. */
export const shopDeals = writable<Record<string, ShopDeal>>({})

export function dealKey(
  merchantPlayerId: string,
  itemDefId: string,
  kind: DealKind
): string {
  return `${merchantPlayerId}|${itemDefId}|${kind}`
}

/** Apply a DealUpdated message; a modifier of 0 clears the deal. */
export function applyDealUpdate(
  merchantPlayerId: string,
  itemDefId: string,
  kind: DealKind,
  modifierPct: number,
  expiresInSecs: number
) {
  shopDeals.update((deals) => {
    const key = dealKey(merchantPlayerId, itemDefId, kind)
    const next = { ...deals }
    if (modifierPct === 0) {
      delete next[key]
    } else {
      next[key] = { modifierPct, expiresAt: Date.now() + expiresInSecs * 1000 }
    }
    return next
  })
}

/** Replace all deals for one merchant (from ShopState.active_deals). */
export function setMerchantDeals(
  merchantPlayerId: string,
  deals: {
    item_def_id: string
    kind: DealKind
    modifier_pct: number
    expires_in_secs: number
  }[]
) {
  shopDeals.update((existing) => {
    const next: Record<string, ShopDeal> = {}
    for (const [key, deal] of Object.entries(existing)) {
      if (!key.startsWith(`${merchantPlayerId}|`)) next[key] = deal
    }
    for (const d of deals) {
      next[dealKey(merchantPlayerId, d.item_def_id, d.kind)] = {
        modifierPct: d.modifier_pct,
        expiresAt: Date.now() + d.expires_in_secs * 1000,
      }
    }
    return next
  })
}
