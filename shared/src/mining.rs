//! Mining protocol types and tuning constants (design: `doc/MINING.md`).
//! Shared so the server (authority), the web client (UI + node rendering)
//! and the agent-client (native node lookup) all read the same shapes and
//! windows. The server owns every timer and roll — clients only render what
//! the broadcasts describe.
//!
//! Ore veins themselves are not stored anywhere: they are a pure function of
//! already-baked terrain tiles (`worldgen::ore_nodes`), the same idiom the
//! client uses for decorative river rocks — every party derives the same
//! nodes from the same tile bytes, so no new bake artifact, endpoint or
//! message is needed to agree on where ore is.

use serde::{Deserialize, Serialize};

/// Stable identity of one ore vein: the tile it was derived on plus its
/// index in that tile's deterministic placement list. Wire-visible so
/// depletion broadcasts can point at a node every client can resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OreNodeKey {
    pub tile_x: i32,
    pub tile_z: i32,
    pub index: u16,
}

/// How a mining session ended, carried by `ServerMessage::MiningEnded`.
/// Every variant reports the session's haul so the agent-client can summarize
/// without replaying strike events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MiningOutcome {
    /// The vein gave everything it had and crumbled; it will respawn.
    Exhausted { ores_gained: u32 },
    /// The miner stopped deliberately (`MiningStop`).
    Stopped { ores_gained: u32 },
    /// Movement, combat, death, disconnect, or losing the pickaxe.
    Aborted { ores_gained: u32 },
}

/// How far from the player a workable vein may be (XZ meters). Nodes sit on
/// cliff faces, so this is arm's reach plus a little slope forgiveness.
pub const MAX_MINING_DISTANCE_METERS: f32 = 3.0;

/// `MiningStart` carries a *position* (a click, or an agent's coordinates),
/// and the server snaps it to the nearest node within this radius. Position,
/// not node id, so an agent can say "mine here" without computing tiles.
pub const NODE_SNAP_DISTANCE_METERS: f32 = 6.0;

/// Base time between pickaxe strikes. Shortened ~2% per mining level,
/// floored at 60% — same shape as fishing's wait shortening. Comfortable
/// for humans and network round trips alike (agent parity: nothing to
/// react to — the server swings for you until you stop or the vein dies).
pub const STRIKE_INTERVAL_MS: u32 = 2_800;

/// Strike interval floor as a percentage of the base.
pub const STRIKE_INTERVAL_FLOOR_PCT: u32 = 60;

/// A strike breaks ore on `d20 + mining_level/2 ≥ STRIKE_DC` — the d20
/// idiom from combat. Level 0 lands 65% of strikes; level 20 lands 95%
/// (a natural 1 always glances off, see the session logic).
pub const STRIKE_DC: i32 = 8;

/// Skill XP per broken ore: `ORE_XP_PER_RARITY_SQ · rarity²` (rarity 1–5).
/// Smaller than fishing's 10 because ore lands every few strikes while a
/// catch takes a whole cast cycle — this anchors XP/hour, not XP/item.
pub const ORE_XP_PER_RARITY_SQ: u64 = 3;

/// How long an exhausted vein stays barren before it respawns.
pub const NODE_RESPAWN_SECONDS: u64 = 300;

/// Effective strike interval for a mining level: 2% faster per level,
/// floored at `STRIKE_INTERVAL_FLOOR_PCT` of the base.
pub fn strike_interval_ms(skill_level: u32) -> u64 {
    let pct = 100u32
        .saturating_sub(skill_level * 2)
        .max(STRIKE_INTERVAL_FLOOR_PCT);
    u64::from(STRIKE_INTERVAL_MS) * u64::from(pct) / 100
}

/// Altitude bonus applied to rare-ore weights: higher veins carry richer
/// ore. One point per 25 m above sea level, capped so the table never
/// collapses into gold. Shared so the doc, the server roll and any client
/// tooltip agree on the same number.
pub fn altitude_weight_bonus(world_y: f32) -> u32 {
    (world_y / 25.0).clamp(0.0, 5.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strike_interval_shortens_with_skill_but_keeps_a_floor() {
        assert_eq!(strike_interval_ms(0), 2_800);
        assert_eq!(strike_interval_ms(10), 2_240);
        // 2% per level would hit 60% exactly at level 20 — the floor binds.
        assert_eq!(strike_interval_ms(20), 1_680);
        assert_eq!(strike_interval_ms(200), 1_680);
    }

    #[test]
    fn altitude_bonus_steps_and_caps() {
        assert_eq!(altitude_weight_bonus(-10.0), 0);
        assert_eq!(altitude_weight_bonus(0.0), 0);
        assert_eq!(altitude_weight_bonus(24.9), 0);
        assert_eq!(altitude_weight_bonus(25.0), 1);
        assert_eq!(altitude_weight_bonus(100.0), 4);
        assert_eq!(altitude_weight_bonus(1_000.0), 5);
    }
}
