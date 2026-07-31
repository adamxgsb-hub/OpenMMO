export const PLAYER_ATTACK_IMPACT_DELAY_MS = 540
export const PLAYER_ATTACK_DAMAGE_TEXT_DELAY_MS = 750

// Player melee reach. Shared by the combat controller (chase/attack break-off)
// and the click-to-attack arrival check so the two never drift apart.
export const PLAYER_ATTACK_RANGE_METERS = 2.0

// Range within which a click picks an item up directly; beyond it the player
// walks over first. Mirrors the server's MAX_PICKUP_DISTANCE (inventory.rs).
export const PLAYER_PICKUP_RANGE_METERS = 2.5

// Range within which a click on an ore outcrop starts mining directly; beyond
// it the player walks up first. Slightly inside the server's
// MAX_MINING_DISTANCE_METERS (shared mining.rs) so a valid click never gets
// refused for range.
export const PLAYER_MINE_RANGE_METERS = 2.5

export const DEFAULT_MONSTER_ATTACK_IMPACT_DELAY_MS = 0

// Fallback attack cooldown when a monster def is missing the field. Mirrors the
// Rust-side MonsterMovement::default().attack_cooldown_ms.
export const DEFAULT_MONSTER_ATTACK_COOLDOWN_MS = 1500
