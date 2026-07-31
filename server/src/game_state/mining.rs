//! Mining sessions: walk to a vein → swing on a server timer → ore breaks
//! free until the vein crumbles (design: `doc/MINING.md`). The server owns
//! every timer and roll; clients render broadcasts and can only start or
//! stop. There is nothing to react to mid-session — agent parity costs the
//! agent zero reflexes, the loop *is* the server.
//!
//! Veins are derived, not stored: `MiningStart` carries a position, the
//! server recomputes the tile's deterministic node list from baked terrain
//! bytes (`worldgen::ore_nodes` via `terrain::ore::OreNodeIndex`) and snaps
//! to the nearest vein. Depletion is the only mutable state, held in memory
//! with a respawn deadline — a restart heals every vein, which is the right
//! failure mode for a renewable resource.
//!
//! Timers are `tokio::time::Instant`s advanced by the 250 ms mining tick,
//! so tests drive the whole machine with `start_paused` + `time::advance`.

use onlinerpg_shared::mining::{
    strike_interval_ms, MiningOutcome, OreNodeKey, MAX_MINING_DISTANCE_METERS,
    NODE_RESPAWN_SECONDS, NODE_SNAP_DISTANCE_METERS, ORE_XP_PER_RARITY_SQ, STRIKE_DC,
};
use onlinerpg_shared::skills::SkillId;
use onlinerpg_shared::Position;
use rand::Rng;
use std::time::Duration;
use tokio::time::Instant;
use tracing::warn;

use super::GameState;
use crate::types::{PlayerId, ServerMessage};

/// Veins only exist on overworld terrain — no mining in dungeons or on
/// house floors (same rule as fishing's cast).
const OVERWORLD_FLOOR: i8 = 0;

pub(crate) struct MiningSession {
    pub node: OreNodeKey,
    pub node_pos: Position,
    /// Ore left in the vein when this session claimed it.
    pub yield_remaining: u8,
    /// `altitude_weight_bonus(node_y)`, frozen at start.
    pub altitude_bonus: u32,
    pub ores_gained: u32,
    pub skill_level: u32,
    pub next_strike_at: Instant,
}

/// Everything the depleted-vein book-keeping needs to refuse re-mining and
/// to broadcast the respawn near the node later.
pub(crate) struct DepletedNode {
    pub respawn_at: Instant,
    pub position: Position,
}

/// Pure yield-table entry, split out so the weighting is unit-testable
/// without a `GameState` (the fishing `CatchCandidate` pattern).
pub(crate) struct OreCandidate {
    pub item_def_id: String,
    pub rarity: u32,
    pub ore_weight: u32,
}

/// Effective weight of one ore for a given mining level and vein altitude:
/// rarer ore gains `rarity` weight per skill level and per altitude step,
/// so high peaks and trained miners both shift the table upward without
/// ever emptying the stone out of it.
pub(crate) fn effective_ore_weight(
    candidate: &OreCandidate,
    skill_level: u32,
    altitude_bonus: u32,
) -> u64 {
    u64::from(candidate.ore_weight)
        + u64::from(skill_level + altitude_bonus) * u64::from(candidate.rarity)
}

/// Weighted pick over the yield table. `roll` is a uniform draw in
/// `[0, total_weight)`; separating the draw from the pick keeps this pure.
pub(crate) fn pick_ore(
    candidates: &[OreCandidate],
    skill_level: u32,
    altitude_bonus: u32,
    mut roll: u64,
) -> Option<usize> {
    for (index, candidate) in candidates.iter().enumerate() {
        let weight = effective_ore_weight(candidate, skill_level, altitude_bonus);
        if roll < weight {
            return Some(index);
        }
        roll -= weight;
    }
    None
}

/// Does a strike break ore? d20 + level/2 against the shared DC; a natural
/// 1 always glances off so even a master hears the rock ring hollow now
/// and then. Pure for seeded-RNG tests.
pub(crate) fn strike_hits(skill_level: u32, rng: &mut impl Rng) -> bool {
    let roll: i32 = rng.gen_range(1..=20);
    roll != 1 && roll + (skill_level / 2) as i32 >= STRIKE_DC
}

impl GameState {
    /// Handle `ClientMessage::MiningStart`: validate pickaxe, floor, reach
    /// and vein state, then open the session on the snapped node.
    pub async fn start_mining(&self, player_id: &PlayerId, target: Position) {
        if self.mining_sessions.read().await.contains_key(player_id) {
            self.send_mining_error(player_id, "You are already mining.")
                .await;
            return;
        }

        let (player_pos, player_floor, alive) = {
            let players = self.players.read().await;
            let Some(p) = players.get(player_id) else {
                return;
            };
            (p.position, p.floor_level, p.health > 0)
        };
        if !alive {
            self.send_mining_error(player_id, "You cannot mine while defeated.")
                .await;
            return;
        }
        if player_floor != OVERWORLD_FLOOR {
            self.send_mining_error(player_id, "You can only mine outdoors.")
                .await;
            return;
        }
        if !self.main_hand_is_pickaxe(player_id).await {
            self.send_mining_error(player_id, "You need a pickaxe in your main hand.")
                .await;
            return;
        }

        // The one async terrain read in the flow, deliberately in the start
        // handler (first-touch tile IO) and never in the tick.
        let target_x = onlinerpg_shared::wrap_world_x(target.x);
        let tile_x = onlinerpg_terrain::coords::world_to_tile(target_x);
        let tile_z = onlinerpg_terrain::coords::world_to_tile(target.z);
        let nodes = match self.ore_nodes.nodes_for_tile(tile_x, tile_z).await {
            Ok(nodes) => nodes,
            Err(err) => {
                warn!("start_mining: ore node derivation failed: {err}");
                self.send_mining_error(player_id, "There is no ore vein there.")
                    .await;
                return;
            }
        };

        // Snap the requested position to the nearest vein.
        let snapped = nodes
            .iter()
            .map(|n| {
                let dx = onlinerpg_shared::shortest_world_delta_x(n.world_x, target_x);
                let dz = n.world_z - target.z;
                (n, dx * dx + dz * dz)
            })
            .filter(|(_, d2)| *d2 <= NODE_SNAP_DISTANCE_METERS * NODE_SNAP_DISTANCE_METERS)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(n, _)| *n);
        let Some(node) = snapped else {
            self.send_mining_error(player_id, "There is no ore vein there.")
                .await;
            return;
        };

        let dx = onlinerpg_shared::shortest_world_delta_x(node.world_x, player_pos.x);
        let dz = node.world_z - player_pos.z;
        if dx * dx + dz * dz > MAX_MINING_DISTANCE_METERS * MAX_MINING_DISTANCE_METERS {
            self.send_mining_error(player_id, "You are too far from the vein.")
                .await;
            return;
        }

        let key = OreNodeKey {
            tile_x,
            tile_z,
            index: node.index,
        };
        if self.depleted_ore_nodes.read().await.contains_key(&key) {
            self.send_mining_error(player_id, "This vein is spent. Give it time to replenish.")
                .await;
            return;
        }
        {
            let sessions = self.mining_sessions.read().await;
            if sessions.values().any(|s| s.node == key) {
                self.send_mining_error(player_id, "Someone is already working this vein.")
                    .await;
                return;
            }
        }

        let skill_level = self
            .get_player_skills(player_id)
            .await
            .get(SkillId::Mining)
            .level;
        let node_pos = Position {
            x: node.world_x,
            y: node.world_y,
            z: node.world_z,
        };
        {
            let mut sessions = self.mining_sessions.write().await;
            // Re-check under the write lock: two simultaneous starts on the
            // same vein must not both claim it.
            if sessions.values().any(|s| s.node == key) {
                drop(sessions);
                self.send_mining_error(player_id, "Someone is already working this vein.")
                    .await;
                return;
            }
            sessions.insert(
                *player_id,
                MiningSession {
                    node: key,
                    node_pos,
                    yield_remaining: node.yield_total,
                    altitude_bonus: onlinerpg_shared::mining::altitude_weight_bonus(node.world_y),
                    ores_gained: 0,
                    skill_level,
                    next_strike_at: Instant::now()
                        + Duration::from_millis(strike_interval_ms(skill_level)),
                },
            );
        }
        self.broadcast_mining(
            &node_pos,
            ServerMessage::MiningStarted {
                player_id: *player_id,
                node: key,
                position: node_pos,
            },
        )
        .await;
    }

    /// Deliberate stop (`ClientMessage::MiningStop`).
    pub async fn stop_mining(&self, player_id: &PlayerId) {
        self.end_mining(player_id, |ores| MiningOutcome::Stopped {
            ores_gained: ores,
        })
        .await;
    }

    /// Anything that breaks concentration — movement, combat, death,
    /// disconnect — lands here. Quiet no-op for the overwhelmingly common
    /// case of a player who isn't mining.
    pub async fn cancel_mining_if_active(&self, player_id: &PlayerId) {
        if self.mining_sessions.read().await.contains_key(player_id) {
            self.end_mining(player_id, |ores| MiningOutcome::Aborted {
                ores_gained: ores,
            })
            .await;
        }
    }

    /// Whether the player's main hand currently holds a pickaxe — the start
    /// precondition, also re-checked when equipment changes mid-session.
    async fn main_hand_is_pickaxe(&self, player_id: &PlayerId) -> bool {
        self.get_player_inventory(player_id)
            .await
            .and_then(|inv| {
                inv.equipped
                    .get(&onlinerpg_shared::inventory::EquipSlot::MainHand)
                    .cloned()
            })
            .and_then(|item| {
                self.item_defs
                    .get(&item.item_def_id)
                    .map(|def| def.is_pickaxe())
            })
            .unwrap_or(false)
    }

    /// Called after any equip/unequip: stowing the pickaxe (or swapping a
    /// weapon into the main hand) drops the session. Gear changes that
    /// leave the pick in hand don't.
    pub(super) async fn abort_mining_if_pickaxe_lost(&self, player_id: &PlayerId) {
        if !self.mining_sessions.read().await.contains_key(player_id) {
            return;
        }
        if !self.main_hand_is_pickaxe(player_id).await {
            self.cancel_mining_if_active(player_id).await;
        }
    }

    /// The 250 ms mining tick: resolves due strikes and respawns crumbled
    /// veins whose timer ran out.
    pub async fn tick_mining(&self) {
        let now = Instant::now();

        // Respawns first, so a vein that crumbles and respawns while someone
        // stands there is announced before their next start attempt.
        let respawned: Vec<(OreNodeKey, Position)> = {
            let mut depleted = self.depleted_ore_nodes.write().await;
            let due: Vec<OreNodeKey> = depleted
                .iter()
                .filter(|(_, d)| now >= d.respawn_at)
                .map(|(k, _)| *k)
                .collect();
            due.into_iter()
                .filter_map(|k| depleted.remove(&k).map(|d| (k, d.position)))
                .collect()
        };
        for (node, position) in respawned {
            self.broadcast_mining(&position, ServerMessage::MiningNodeRespawned { node })
                .await;
        }

        let due_strikes: Vec<PlayerId> = {
            let sessions = self.mining_sessions.read().await;
            if sessions.is_empty() {
                return;
            }
            sessions
                .iter()
                .filter(|(_, s)| now >= s.next_strike_at)
                .map(|(id, _)| *id)
                .collect()
        };
        for player_id in due_strikes {
            self.resolve_strike(&player_id, now).await;
        }
    }

    /// One pickaxe strike: hit roll, ore roll, award + XP, depletion.
    async fn resolve_strike(&self, player_id: &PlayerId, now: Instant) {
        let alive = {
            let players = self.players.read().await;
            players.get(player_id).is_some_and(|p| p.health > 0)
        };
        if !alive {
            self.end_mining(player_id, |ores| MiningOutcome::Aborted {
                ores_gained: ores,
            })
            .await;
            return;
        }

        // Roll under an await-free block (thread_rng is !Send), then apply.
        let (node, node_pos, skill_level, altitude_bonus) = {
            let sessions = self.mining_sessions.read().await;
            let Some(s) = sessions.get(player_id) else {
                return;
            };
            (s.node, s.node_pos, s.skill_level, s.altitude_bonus)
        };
        let table = self.item_defs.ore_table();
        let rolled_ore: Option<usize> = {
            let mut rng = rand::thread_rng();
            if !strike_hits(skill_level, &mut rng) || table.is_empty() {
                None
            } else {
                let total: u64 = table
                    .iter()
                    .map(|c| effective_ore_weight(c, skill_level, altitude_bonus))
                    .sum();
                if total == 0 {
                    None
                } else {
                    pick_ore(&table, skill_level, altitude_bonus, rng.gen_range(0..total))
                }
            }
        };

        let (ore_id, exhausted) = {
            let mut sessions = self.mining_sessions.write().await;
            let Some(s) = sessions.get_mut(player_id) else {
                return;
            };
            s.next_strike_at = now + Duration::from_millis(strike_interval_ms(s.skill_level));
            match rolled_ore {
                Some(index) => {
                    s.yield_remaining = s.yield_remaining.saturating_sub(1);
                    s.ores_gained += 1;
                    (
                        Some(table[index].item_def_id.clone()),
                        s.yield_remaining == 0,
                    )
                }
                None => (None, false),
            }
        };

        if let Some(ore_id) = &ore_id {
            self.award_stackable_item(player_id, ore_id).await;
            let rarity = self
                .item_defs
                .get(ore_id)
                .and_then(|def| def.rarity_tier)
                .unwrap_or(1);
            let xp = ORE_XP_PER_RARITY_SQ * u64::from(rarity) * u64::from(rarity);
            self.add_skill_xp(player_id, SkillId::Mining, xp).await;
        }
        self.broadcast_mining(
            &node_pos,
            ServerMessage::MiningStrike {
                player_id: *player_id,
                node,
                ore_item_def_id: ore_id,
            },
        )
        .await;

        if exhausted {
            self.depleted_ore_nodes.write().await.insert(
                node,
                DepletedNode {
                    respawn_at: now + Duration::from_secs(NODE_RESPAWN_SECONDS),
                    position: node_pos,
                },
            );
            self.broadcast_mining(
                &node_pos,
                ServerMessage::MiningNodeDepleted {
                    node,
                    respawn_seconds: NODE_RESPAWN_SECONDS as u32,
                },
            )
            .await;
            self.end_mining(player_id, |ores| MiningOutcome::Exhausted {
                ores_gained: ores,
            })
            .await;
        }
    }

    /// Remove the session (if any) and broadcast how it ended. The outcome
    /// is built from the session's haul so every path reports it.
    async fn end_mining(&self, player_id: &PlayerId, outcome: impl FnOnce(u32) -> MiningOutcome) {
        let Some(session) = self.mining_sessions.write().await.remove(player_id) else {
            return;
        };
        self.broadcast_mining(
            &session.node_pos,
            ServerMessage::MiningEnded {
                player_id: *player_id,
                outcome: outcome(session.ores_gained),
            },
        )
        .await;
    }

    /// Mining events go to everyone near the vein on the overworld floor —
    /// the miner is within reach of it by construction.
    async fn broadcast_mining(&self, node_pos: &Position, msg: ServerMessage) {
        self.send_direct_message_to_players_within_position(
            node_pos,
            OVERWORLD_FLOOR,
            super::EVENT_DELIVERY_RADIUS,
            msg,
            None,
        )
        .await;
    }

    async fn send_mining_error(&self, player_id: &PlayerId, message: &str) {
        self.send_direct_message(
            player_id,
            ServerMessage::MiningError {
                message: message.to_string(),
            },
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn table() -> Vec<OreCandidate> {
        vec![
            OreCandidate {
                item_def_id: "chunk_of_stone".into(),
                rarity: 1,
                ore_weight: 45,
            },
            OreCandidate {
                item_def_id: "gold_ore".into(),
                rarity: 5,
                ore_weight: 2,
            },
        ]
    }

    #[test]
    fn weighting_scales_rarity_with_skill_and_altitude() {
        let t = table();
        assert_eq!(effective_ore_weight(&t[0], 0, 0), 45);
        assert_eq!(effective_ore_weight(&t[1], 0, 0), 2);
        // Level 20 on a +5 peak: stone 45+25, gold 2+125 — rich veins pull
        // ahead but the stone never vanishes.
        assert_eq!(effective_ore_weight(&t[0], 20, 5), 70);
        assert_eq!(effective_ore_weight(&t[1], 20, 5), 127);
    }

    #[test]
    fn pick_walks_cumulative_weights() {
        let t = table();
        assert_eq!(pick_ore(&t, 0, 0, 0), Some(0));
        assert_eq!(pick_ore(&t, 0, 0, 44), Some(0));
        assert_eq!(pick_ore(&t, 0, 0, 45), Some(1));
        assert_eq!(pick_ore(&t, 0, 0, 46), Some(1));
        // Out-of-range roll (caller bug) picks nothing rather than panicking.
        assert_eq!(pick_ore(&t, 0, 0, 47), None);
    }

    #[test]
    fn strike_odds_improve_with_skill_but_nat_one_misses() {
        // Exhaustive over seeds: level 20 must never hit on a natural 1 and
        // must hit strictly more often than level 0 over a long run.
        let mut hits_novice = 0u32;
        let mut hits_master = 0u32;
        for seed in 0..2_000u64 {
            let mut rng = StdRng::seed_from_u64(seed);
            if strike_hits(0, &mut rng) {
                hits_novice += 1;
            }
            let mut rng = StdRng::seed_from_u64(seed);
            if strike_hits(20, &mut rng) {
                hits_master += 1;
            }
        }
        assert!(hits_master > hits_novice);
        // 65% and 95% expectations, loosely banded.
        assert!((1_100..=1_500).contains(&hits_novice), "{hits_novice}");
        assert!((1_800..=1_950).contains(&hits_master), "{hits_master}");
    }
}
