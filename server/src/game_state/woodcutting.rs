//! Chopping sessions: target a baked tree → swing on the server's clock →
//! the tree falls, logs land, a stump waits out its regrow timer (design:
//! `doc/WOODCUTTING.md`). The trees are the world's own TR01 instances —
//! the same bytes the client renders — so validation is "does that tree
//! actually stand there", decoded from the same tile file.
//!
//! Deliberately no reflex mechanic: fishing's bite window exists to make a
//! catch feel earned; a felling is earned by standing there swinging.
//! Everything after `ChopTree` runs on the server's 250 ms tick, so a human,
//! a laggy human, and an agent-client chop identically (agent parity by
//! construction). Timers are `tokio::time::Instant`s, so tests drive the
//! whole machine with `start_paused` + `time::advance`, the fishing pattern.

use onlinerpg_shared::skills::SkillId;
use onlinerpg_shared::woodcutting::{
    chop_xp, log_item_id, log_yield, min_level_to_chop, swings_to_fell, TreeRef, TreeStump,
    WoodcuttingOutcome, MAX_CHOP_DISTANCE_METERS, SWING_MS, TREE_RESPAWN_MS,
    TREE_SNAP_RADIUS_METERS,
};
use onlinerpg_shared::Position;
use std::time::Duration;
use tokio::time::Instant;
use tracing::warn;

use super::GameState;
use crate::types::{PlayerId, ServerMessage};

/// Chopping is an overworld activity, like casting a line — no felling
/// dungeon props or house-floor fictions.
const OVERWORLD_FLOOR: i8 = 0;

pub(crate) struct ChopSession {
    pub tree: TreeRef,
    /// Trunk position (Y from the terrain bed), the anchor for broadcasts.
    pub trunk: Position,
    pub kind: u8,
    pub scale: f32,
    pub swings_done: u32,
    pub swings_needed: u32,
    pub next_swing_at: Instant,
}

impl GameState {
    /// Handle `ClientMessage::ChopTree`: find the standing tree nearest the
    /// requested point, validate everything the design requires (axe, floor,
    /// range, skill gate, liveness, contention), and open the session.
    pub async fn start_chopping(&self, player_id: &PlayerId, target: Position) {
        if self.chop_sessions.read().await.contains_key(player_id) {
            self.send_woodcutting_error(player_id, "You are already chopping.")
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
            self.send_woodcutting_error(player_id, "You cannot chop while defeated.")
                .await;
            return;
        }
        if player_floor != OVERWORLD_FLOOR {
            self.send_woodcutting_error(player_id, "You can only cut trees outdoors.")
                .await;
            return;
        }
        if !self.main_hand_is_axe(player_id).await {
            self.send_woodcutting_error(player_id, "You need a woodcutting axe in your main hand.")
                .await;
            return;
        }

        // Find the nearest standing baked tree within the snap radius of the
        // requested point. The async tile reads live here in the handler
        // (first-touch tile IO), never in the tick — the fishing rule.
        let target = Position {
            x: onlinerpg_shared::wrap_world_x(target.x),
            ..target
        };
        let Some((tree, trunk_x, trunk_z, scale)) = self.find_standing_tree_near(&target).await
        else {
            self.send_woodcutting_error(player_id, "There is no tree to cut there.")
                .await;
            return;
        };

        let dx = onlinerpg_shared::shortest_world_delta_x(trunk_x, player_pos.x);
        let dz = trunk_z - player_pos.z;
        if dx * dx + dz * dz > MAX_CHOP_DISTANCE_METERS * MAX_CHOP_DISTANCE_METERS {
            self.send_woodcutting_error(player_id, "That tree is out of reach — walk to it first.")
                .await;
            return;
        }

        let skill_level = self
            .get_player_skills(player_id)
            .await
            .get(SkillId::Woodcutting)
            .level;
        let required = min_level_to_chop(tree.kind, scale);
        if skill_level < required {
            self.send_woodcutting_error(
                player_id,
                &format!("That tree is too mighty for your axe. (Woodcutting {required} required)"),
            )
            .await;
            return;
        }

        // One chopper per tree: the first axe claims it.
        {
            let sessions = self.chop_sessions.read().await;
            if sessions.values().any(|s| s.tree == tree) {
                self.send_woodcutting_error(player_id, "Someone is already chopping that tree.")
                    .await;
                return;
            }
        }

        // Trunk Y from the terrain bed, for a broadcast anchor bystander
        // clients can place effects at.
        let trunk_y = self
            .height_sampler
            .sample_height(trunk_x, trunk_z)
            .await
            .unwrap_or(player_pos.y);
        let trunk = Position {
            x: trunk_x,
            y: trunk_y,
            z: trunk_z,
        };

        // Setting an axe to a tree reels in any line first.
        self.cancel_fishing_if_active(player_id).await;

        let swings_needed = swings_to_fell(tree.kind, scale, skill_level);
        {
            let mut sessions = self.chop_sessions.write().await;
            sessions.insert(
                *player_id,
                ChopSession {
                    tree,
                    trunk,
                    kind: tree.kind,
                    scale,
                    swings_done: 0,
                    swings_needed,
                    next_swing_at: Instant::now() + Duration::from_millis(u64::from(SWING_MS)),
                },
            );
        }
        self.broadcast_woodcutting(
            &trunk,
            ServerMessage::ChopStarted {
                player_id: *player_id,
                tree,
                position: trunk,
                swings_needed,
                swing_ms: SWING_MS,
            },
        )
        .await;
    }

    /// Deliberate stop (`ClientMessage::ChopStop`).
    pub async fn stop_chopping(&self, player_id: &PlayerId) {
        self.end_chopping(player_id, WoodcuttingOutcome::Aborted)
            .await;
    }

    /// Anything that breaks the work — movement, combat, death, disconnect —
    /// lands here. Quiet no-op for the common case of a player who isn't
    /// chopping.
    pub async fn cancel_chopping_if_active(&self, player_id: &PlayerId) {
        if self.chop_sessions.read().await.contains_key(player_id) {
            self.end_chopping(player_id, WoodcuttingOutcome::Aborted)
                .await;
        }
    }

    /// Whether the player's main hand currently holds a woodcutting axe —
    /// the chop precondition, also re-checked when equipment changes.
    async fn main_hand_is_axe(&self, player_id: &PlayerId) -> bool {
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
                    .map(|def| def.is_woodcutting_axe())
            })
            .unwrap_or(false)
    }

    /// Called after any equip/unequip: putting the axe away mid-swing stops
    /// the work, the `abort_fishing_if_rod_lost` twin.
    pub(super) async fn abort_chopping_if_axe_lost(&self, player_id: &PlayerId) {
        if !self.chop_sessions.read().await.contains_key(player_id) {
            return;
        }
        if !self.main_hand_is_axe(player_id).await {
            self.cancel_chopping_if_active(player_id).await;
        }
    }

    /// The join snapshot for `ServerMessage::TreeStumps`: every currently
    /// felled tree with its remaining regrow time.
    pub async fn tree_stump_snapshot(&self) -> Vec<TreeStump> {
        let now = Instant::now();
        let stumps = self.tree_stumps.read().await;
        let mut out: Vec<TreeStump> = stumps
            .iter()
            .map(|(tree, respawn_at)| TreeStump {
                tree: *tree,
                respawn_in_ms: respawn_at
                    .saturating_duration_since(now)
                    .as_millis()
                    .min(u128::from(u32::MAX)) as u32,
            })
            .collect();
        // Deterministic order for tests and stable wire bytes.
        out.sort_by_key(|s| (s.tree.tile_x, s.tree.tile_z, s.tree.kind, s.tree.index));
        out
    }

    /// The 250 ms woodcutting tick: lands due swings, fells finished trees,
    /// aborts dead/vanished choppers, and regrows due stumps.
    pub async fn tick_woodcutting(&self) {
        let now = Instant::now();
        enum Due {
            Swing(PlayerId),
            PlayerGone(PlayerId),
        }
        let mut due = Vec::new();
        {
            let sessions = self.chop_sessions.read().await;
            if !sessions.is_empty() {
                let players = self.players.read().await;
                for (player_id, session) in sessions.iter() {
                    let alive = players.get(player_id).is_some_and(|p| p.health > 0);
                    if !alive {
                        due.push(Due::PlayerGone(*player_id));
                    } else if now >= session.next_swing_at {
                        due.push(Due::Swing(*player_id));
                    }
                }
            }
        }

        for entry in due {
            match entry {
                Due::PlayerGone(player_id) => {
                    self.end_chopping(&player_id, WoodcuttingOutcome::Aborted)
                        .await;
                }
                Due::Swing(player_id) => {
                    enum Landed {
                        Progress {
                            trunk: Position,
                            swings_done: u32,
                            swings_needed: u32,
                        },
                        Felled,
                    }
                    let landed = {
                        let mut sessions = self.chop_sessions.write().await;
                        let Some(session) = sessions.get_mut(&player_id) else {
                            continue;
                        };
                        session.swings_done += 1;
                        if session.swings_done >= session.swings_needed {
                            Landed::Felled
                        } else {
                            session.next_swing_at =
                                now + Duration::from_millis(u64::from(SWING_MS));
                            Landed::Progress {
                                trunk: session.trunk,
                                swings_done: session.swings_done,
                                swings_needed: session.swings_needed,
                            }
                        }
                    };
                    match landed {
                        Landed::Progress {
                            trunk,
                            swings_done,
                            swings_needed,
                        } => {
                            self.broadcast_woodcutting(
                                &trunk,
                                ServerMessage::ChopSwing {
                                    player_id,
                                    swings_done,
                                    swings_needed,
                                },
                            )
                            .await;
                        }
                        Landed::Felled => self.finish_chop_felled(&player_id).await,
                    }
                }
            }
        }

        // Regrow due stumps. Collect-then-broadcast so the lock isn't held
        // across sends.
        let regrown: Vec<TreeRef> = {
            let mut stumps = self.tree_stumps.write().await;
            let due: Vec<TreeRef> = stumps
                .iter()
                .filter(|(_, respawn_at)| now >= **respawn_at)
                .map(|(tree, _)| *tree)
                .collect();
            for tree in &due {
                stumps.remove(tree);
            }
            due
        };
        for tree in regrown {
            self.broadcast(ServerMessage::TreeRespawned { tree });
        }
    }

    /// The last swing landed: the tree falls. Award the logs (bag, or ground
    /// when overweight), grant skill XP, plant the stump, and tell the world.
    async fn finish_chop_felled(&self, player_id: &PlayerId) {
        let Some(session) = self.chop_sessions.write().await.remove(player_id) else {
            return;
        };
        let Some(item_def_id) = log_item_id(session.kind) else {
            // Can't happen for a validated session; fail closed.
            warn!("finish_chop_felled: no log item for kind {}", session.kind);
            return;
        };
        let logs = log_yield(session.kind, session.scale);
        for _ in 0..logs {
            self.award_item(player_id, item_def_id).await;
        }
        self.add_skill_xp(
            player_id,
            SkillId::Woodcutting,
            chop_xp(session.kind, session.scale),
        )
        .await;

        {
            let mut stumps = self.tree_stumps.write().await;
            stumps.insert(
                session.tree,
                Instant::now() + Duration::from_millis(u64::from(TREE_RESPAWN_MS)),
            );
        }
        // World-wide: every client must agree on which trees stand, no
        // matter where it was when this one fell (see messages.rs).
        self.broadcast(ServerMessage::TreeFelled {
            tree: session.tree,
            respawn_in_ms: TREE_RESPAWN_MS,
        });
        self.broadcast_woodcutting(
            &session.trunk,
            ServerMessage::WoodcuttingEnded {
                player_id: *player_id,
                outcome: WoodcuttingOutcome::Felled {
                    item_def_id: item_def_id.to_string(),
                    logs,
                },
            },
        )
        .await;
    }

    /// Remove the session (if any) and broadcast how it ended.
    async fn end_chopping(&self, player_id: &PlayerId, outcome: WoodcuttingOutcome) {
        let Some(session) = self.chop_sessions.write().await.remove(player_id) else {
            return;
        };
        self.broadcast_woodcutting(
            &session.trunk,
            ServerMessage::WoodcuttingEnded {
                player_id: *player_id,
                outcome,
            },
        )
        .await;
    }

    /// Nearest standing baked tree to `target` within the snap radius:
    /// reads every tile the snap circle overlaps, decodes it, and skips
    /// stumps. Returns the tree's address, trunk XZ, and baked scale.
    async fn find_standing_tree_near(&self, target: &Position) -> Option<(TreeRef, f32, f32, f32)> {
        let r = TREE_SNAP_RADIUS_METERS;
        let tile_min_x = onlinerpg_terrain::coords::world_to_tile(target.x - r);
        let tile_max_x = onlinerpg_terrain::coords::world_to_tile(target.x + r);
        let tile_min_z = onlinerpg_terrain::coords::world_to_tile(target.z - r);
        let tile_max_z = onlinerpg_terrain::coords::world_to_tile(target.z + r);

        let stumps = {
            let stumps = self.tree_stumps.read().await;
            stumps.keys().copied().collect::<Vec<_>>()
        };

        let mut best: Option<(TreeRef, f32, f32, f32)> = None;
        let mut best_dist_sq = r * r;
        for tile_z in tile_min_z..=tile_max_z {
            for tile_x in tile_min_x..=tile_max_x {
                let slots = match self.tree_reader.tile_instances(tile_x, tile_z).await {
                    Ok(slots) => slots,
                    Err(err) => {
                        warn!("find_standing_tree_near: tree tile read failed: {err}");
                        continue;
                    }
                };
                for (kind, instances) in slots.iter().enumerate() {
                    for (index, instance) in instances.iter().enumerate() {
                        let tree = TreeRef {
                            tile_x,
                            tile_z,
                            kind: kind as u8,
                            index: index as u32,
                        };
                        if stumps.contains(&tree) {
                            continue;
                        }
                        let dx =
                            onlinerpg_shared::shortest_world_delta_x(instance.world_x, target.x);
                        let dz = instance.world_z - target.z;
                        let dist_sq = dx * dx + dz * dz;
                        if dist_sq <= best_dist_sq {
                            best = Some((tree, instance.world_x, instance.world_z, instance.scale));
                            best_dist_sq = dist_sq;
                        }
                    }
                }
            }
        }
        best
    }

    /// Woodcutting events go to everyone near the trunk on the overworld
    /// floor — the chopper is inside axe range of it by construction.
    async fn broadcast_woodcutting(&self, trunk: &Position, msg: ServerMessage) {
        self.send_direct_message_to_players_within_position(
            trunk,
            OVERWORLD_FLOOR,
            super::EVENT_DELIVERY_RADIUS,
            msg,
            None,
        )
        .await;
    }

    async fn send_woodcutting_error(&self, player_id: &PlayerId, message: &str) {
        self.send_direct_message(
            player_id,
            ServerMessage::WoodcuttingError {
                message: message.to_string(),
            },
        )
        .await;
    }
}
