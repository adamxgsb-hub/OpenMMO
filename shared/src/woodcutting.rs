//! Woodcutting protocol types and tuning constants (design:
//! `doc/WOODCUTTING.md`). Shared so the server (authority), the web client
//! (UI + tree hiding) and the agent-client (chop actions) all read the same
//! shapes and numbers. The trees themselves are the baked TR01 instances the
//! world already renders (`tree_format.rs`) — woodcutting adds no new
//! placement data, it harvests what is there.
//!
//! Unlike fishing there is no reflex mechanic at all: once a chop starts the
//! server swings on its own clock until the tree falls or the chopper is
//! interrupted. Agent parity by construction — there is nothing to react to.

use serde::{Deserialize, Serialize};

use crate::tree_format::TREE_V1_SCALE;

/// One baked tree instance, addressed the way the TR01 tile format stores it:
/// the tile, the model slot (`0` = `tree.glb`, `1` = `tree2.glb` — the
/// convention of `tree_format.rs`), and the index within that slot's array.
/// Client and server decode the same tile bytes, so the address is stable as
/// long as the baked tile is unchanged (housing prunes rewrite tiles and
/// shift indices; live sessions and stumps tolerate that — see the server).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TreeRef {
    pub tile_x: i32,
    pub tile_z: i32,
    pub kind: u8,
    pub index: u32,
}

/// A felled tree that has not grown back yet, as carried by
/// `ServerMessage::TreeStumps` (the join snapshot).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeStump {
    pub tree: TreeRef,
    pub respawn_in_ms: u32,
}

/// How a chopping session ended, carried by `ServerMessage::WoodcuttingEnded`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum WoodcuttingOutcome {
    /// The tree came down. Logs arrive via the normal `InventoryUpdated`
    /// (or spill to the ground when the bag can't take the weight); this
    /// carries what fell for the outcome toast.
    Felled { item_def_id: String, logs: u32 },
    /// The chopper moved, fought, lost the axe, or stopped deliberately.
    Aborted,
}

/// How far from the player a tree trunk may be to start chopping (XZ meters).
/// Wider than a door (2 m): the big `tree.glb` oaks are broad enough that the
/// trunk center sits well inside the canopy.
pub const MAX_CHOP_DISTANCE_METERS: f32 = 4.0;

/// How far from the requested point the server searches for a standing tree.
/// The client resolves a click to a trunk and sends that exact position; the
/// agent-client sends a rough point (or just its own feet) and lets the
/// server snap — same information, same result.
pub const TREE_SNAP_RADIUS_METERS: f32 = 4.0;

/// One axe swing per this interval, driven by the server's woodcutting tick.
pub const SWING_MS: u32 = 1_500;

/// A felled tree grows back this long after it fell. Long enough that a
/// chopper roams between trees instead of camping one, short enough that a
/// grove recovers within a play session.
pub const TREE_RESPAWN_MS: u32 = 120_000;

/// Skill XP per log, by tree kind: the big broadleafs (`tree.glb`) pay
/// double the common timber trees (`tree2.glb`).
pub const XP_PER_LOG: [u64; 2] = [12, 6];

/// The timber a tree kind yields when felled. Kind 0 (`tree.glb`, the big
/// broadleaf) drops dense hardwood; kind 1 (`tree2.glb`) drops common timber.
pub fn log_item_id(kind: u8) -> Option<&'static str> {
    match kind {
        0 => Some("oak_log"),
        1 => Some("timber_log"),
        _ => None,
    }
}

/// Whether `kind` is a valid TR01 model slot.
pub fn is_valid_tree_kind(kind: u8) -> bool {
    (kind as usize) < TREE_V1_SCALE.len()
}

/// Axe swings to fell a tree: bigger trees take more, skill takes a few
/// off, and nothing falls in under three swings — a felling is always a
/// visible commitment, never a drive-by tap.
pub fn swings_to_fell(kind: u8, scale: f32, skill_level: u32) -> u32 {
    let base: f32 = match kind {
        0 => 4.0 + 2.0 * scale,
        _ => 3.0 + 2.0 * scale,
    };
    (base.round() as u32).saturating_sub(skill_level / 6).max(3)
}

/// Logs a felled tree yields. Scale is the baked instance scale, so the
/// world's own size variety (0.7–3.0 oaks, 0.6–1.4 timber trees) is what
/// drives the reward.
pub fn log_yield(kind: u8, scale: f32) -> u32 {
    match kind {
        0 => 1 + scale.max(0.0) as u32,
        _ => {
            if scale >= 1.2 {
                2
            } else {
                1
            }
        }
    }
}

/// Skill XP for felling a tree: per-log XP times the yield, so the reward
/// tracks exactly what landed in the bag.
pub fn chop_xp(kind: u8, scale: f32) -> u64 {
    let per_log = XP_PER_LOG
        .get(kind as usize)
        .copied()
        .unwrap_or(XP_PER_LOG[1]);
    per_log * u64::from(log_yield(kind, scale))
}

/// Oaks at or above this baked scale need Woodcutting 10.
pub const OAK_GATE_SCALE_L10: f32 = 1.8;
/// Oaks at or above this baked scale ("ancient oaks") need Woodcutting 20.
pub const OAK_GATE_SCALE_L20: f32 = 2.6;
/// The level the mid-size oak gate unlocks at.
pub const OAK_GATE_LEVEL_MID: u32 = 10;
/// The level the ancient-oak gate unlocks at.
pub const OAK_GATE_LEVEL_ANCIENT: u32 = 20;

/// Minimum Woodcutting level to chop a given tree. The unlock ladder is
/// spaced against `SKILL_LEVEL_CAP` the way fishing spaces salmon (10) and
/// sturgeon (20): common trees from the first swing, the world's biggest
/// oaks as the long goal. Gates come from the baked instance scale — the
/// trees you can't cut yet are literally the tallest ones on screen.
pub fn min_level_to_chop(kind: u8, scale: f32) -> u32 {
    if kind != 0 {
        return 0;
    }
    if scale >= OAK_GATE_SCALE_L20 {
        OAK_GATE_LEVEL_ANCIENT
    } else if scale >= OAK_GATE_SCALE_L10 {
        OAK_GATE_LEVEL_MID
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SKILL_LEVEL_CAP;

    #[test]
    fn swings_scale_with_tree_size_and_shrink_with_skill() {
        // The smallest baked oak and the biggest (TREE_V1_SCALE slot 0:
        // 0.7 … 3.0).
        assert_eq!(swings_to_fell(0, 0.7, 0), 5);
        assert_eq!(swings_to_fell(0, 3.0, 0), 10);
        // The smallest and biggest timber tree (slot 1: 0.6 … 1.4).
        assert_eq!(swings_to_fell(1, 0.6, 0), 4);
        assert_eq!(swings_to_fell(1, 1.4, 0), 6);
        // Mastery is faster but never instant.
        assert_eq!(swings_to_fell(0, 3.0, SKILL_LEVEL_CAP), 5);
        assert_eq!(swings_to_fell(1, 0.6, SKILL_LEVEL_CAP), 3);
        assert!(swings_to_fell(1, 0.0, u32::MAX) >= 3);
    }

    #[test]
    fn yield_tracks_the_baked_size_variety() {
        assert_eq!(log_yield(0, 0.7), 1);
        assert_eq!(log_yield(0, 1.5), 2);
        assert_eq!(log_yield(0, 2.5), 3);
        assert_eq!(log_yield(0, 3.0), 4);
        assert_eq!(log_yield(1, 0.6), 1);
        assert_eq!(log_yield(1, 1.2), 2);
        assert_eq!(log_yield(1, 1.4), 2);
    }

    #[test]
    fn xp_is_per_log_and_oak_pays_double() {
        assert_eq!(chop_xp(0, 3.0), 48); // 4 oak logs × 12
        assert_eq!(chop_xp(0, 0.7), 12);
        assert_eq!(chop_xp(1, 0.6), 6);
        assert_eq!(chop_xp(1, 1.4), 12);
    }

    #[test]
    fn the_unlock_ladder_gates_only_big_oaks() {
        assert_eq!(min_level_to_chop(0, 0.7), 0);
        assert_eq!(min_level_to_chop(0, OAK_GATE_SCALE_L10), OAK_GATE_LEVEL_MID);
        assert_eq!(
            min_level_to_chop(0, OAK_GATE_SCALE_L20),
            OAK_GATE_LEVEL_ANCIENT
        );
        // Timber trees are never gated — the skill is for everyone, day one.
        assert_eq!(min_level_to_chop(1, 1.4), 0);
        // The ladder tops out inside the cap, like salmon (10) and
        // sturgeon (20) do for fishing.
        assert!(min_level_to_chop(0, 3.0) < SKILL_LEVEL_CAP);
    }

    #[test]
    fn every_kind_maps_to_a_log_item() {
        assert_eq!(log_item_id(0), Some("oak_log"));
        assert_eq!(log_item_id(1), Some("timber_log"));
        assert_eq!(log_item_id(2), None);
        assert!(is_valid_tree_kind(0) && is_valid_tree_kind(1));
        assert!(!is_valid_tree_kind(2));
    }
}
