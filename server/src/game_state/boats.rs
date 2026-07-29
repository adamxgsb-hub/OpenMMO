//! Boats: launch from a deed, sail validated water, carry riders
//! (design: `doc/BOATS.md`). Server-authoritative like fishing — the boat's
//! position, route and everyone aboard live here; clients render one
//! broadcast transform and never move a rider themselves.
//!
//! Water is judged with the same two samplers as fishing's cast check
//! (depth = water surface − terrain bed), and, like fishing, every sample
//! happens in an async handler — `tick_boats` only ever walks routes that
//! `sail_boat` already validated point by point.

use std::collections::VecDeque;

use onlinerpg_shared::boats::{
    BoatId, BoatPassenger, BoatSnapshot, BOAT_SEATS, MIN_NAV_DEPTH_M, SHORE_PROBE_RADIUS_M,
};
use onlinerpg_shared::messages::ServerMessage;
use onlinerpg_shared::{wrap_world_x, PlayerId, Position};
use tracing::warn;

use super::GameState;

/// Boats are an outdoors thing, like fishing bobbers.
const OVERWORLD_FLOOR: i8 = 0;

/// Launch probe distances from the player, meters — the hull needs a little
/// clearance from the shoreline, so the nearest try is a boat-length out.
const LAUNCH_PROBE_DISTANCES: [f32; 3] = [2.0, 4.0, 6.0];

/// One boat afloat. The deed in its owner's bag is the durable object; this
/// struct exists only between launch and stow.
pub(crate) struct Boat {
    pub id: BoatId,
    pub owner: PlayerId,
    /// Hull position; `y` is the sampled water surface.
    pub position: Position,
    pub heading: f32,
    /// Water-validated waypoints ahead, `y` pre-sampled — `tick_boats`
    /// follows them without touching a sampler.
    pub route: VecDeque<Position>,
    /// Everyone aboard; index is the seat, the owner holds seat 0.
    pub passengers: Vec<PlayerId>,
}

impl Boat {
    pub fn snapshot(&self) -> BoatSnapshot {
        BoatSnapshot {
            id: self.id,
            owner: self.owner,
            position: self.position,
            heading: self.heading,
            passengers: self
                .passengers
                .iter()
                .enumerate()
                .map(|(seat, player_id)| BoatPassenger {
                    player_id: *player_id,
                    seat: seat as u8,
                })
                .collect(),
        }
    }
}

impl GameState {
    /// Handle using a boat deed from the bag: aboard your own still boat it
    /// packs the boat up; ashore it launches one. The deed is never
    /// consumed — it *is* the boat, rolled up.
    pub async fn use_boat_deed(&self, player_id: &PlayerId) {
        if let Some(boat_id) = self.is_aboard(player_id).await {
            self.stow_boat(player_id, boat_id).await;
        } else {
            self.launch_boat(player_id).await;
        }
    }

    /// The boat the player is currently aboard, if any.
    pub async fn is_aboard(&self, player_id: &PlayerId) -> Option<BoatId> {
        self.boats
            .read()
            .await
            .values()
            .find(|boat| boat.passengers.contains(player_id))
            .map(|boat| boat.id)
    }

    async fn launch_boat(&self, player_id: &PlayerId) {
        let (player_pos, player_floor, alive) = {
            let players = self.players.read().await;
            let Some(p) = players.get(player_id) else {
                return;
            };
            (p.position, p.floor_level, p.health > 0)
        };
        if !alive {
            self.send_boat_error(player_id, "You cannot launch a boat while defeated.")
                .await;
            return;
        }
        if player_floor != OVERWORLD_FLOOR {
            self.send_boat_error(player_id, "You can only launch a boat outdoors.")
                .await;
            return;
        }
        if self
            .boats
            .read()
            .await
            .values()
            .any(|boat| boat.owner == *player_id)
        {
            self.send_boat_error(player_id, "Your boat is already in the water.")
                .await;
            return;
        }

        // Probe around the player for water deep enough to float a keel —
        // async sampler reads, handler-side only (the fishing rule).
        let Some(spot) = self
            .find_nearby_point(&player_pos, &LAUNCH_PROBE_DISTANCES, |depth| {
                depth > MIN_NAV_DEPTH_M
            })
            .await
        else {
            self.send_boat_error(
                player_id,
                "You need to stand at the water's edge to launch your boat.",
            )
            .await;
            return;
        };

        let boat_id = {
            let mut next = self.next_boat_id.write().await;
            let id = *next;
            *next += 1;
            id
        };
        let heading = onlinerpg_shared::boats::heading_of(
            onlinerpg_shared::shortest_world_delta_x(player_pos.x, spot.x),
            spot.z - player_pos.z,
        );
        let snapshot = {
            let mut boats = self.boats.write().await;
            let boat = Boat {
                id: boat_id,
                owner: *player_id,
                position: spot,
                heading,
                route: VecDeque::new(),
                passengers: vec![*player_id],
            };
            let snapshot = boat.snapshot();
            boats.insert(boat_id, boat);
            snapshot
        };

        // Step the owner aboard: their position becomes the hull's. This is
        // the one PlayerMoved a rider generates — after it, the boat's own
        // broadcasts carry everyone.
        self.cancel_fishing_if_active(player_id).await;
        self.apply_player_position(
            player_id,
            spot,
            heading,
            OVERWORLD_FLOOR,
            ServerMessage::PlayerMoved {
                player_id: *player_id,
                position: spot,
                rotation: heading,
                floor_level: OVERWORLD_FLOOR,
            },
        )
        .await;
        self.broadcast_boat(&spot, ServerMessage::BoatSpawned { boat: snapshot })
            .await;
    }

    async fn stow_boat(&self, player_id: &PlayerId, boat_id: BoatId) {
        let position = {
            let boats = self.boats.read().await;
            let Some(boat) = boats.get(&boat_id) else {
                return;
            };
            if boat.owner != *player_id {
                self.send_boat_error(player_id, "Only the owner can pack the boat up.")
                    .await;
                return;
            }
            if !boat.route.is_empty() {
                self.send_boat_error(player_id, "Drop anchor before packing up.")
                    .await;
                return;
            }
            if boat.passengers.len() > 1 {
                self.send_boat_error(
                    player_id,
                    "You cannot pack up the boat while others are aboard.",
                )
                .await;
                return;
            }
            boat.position
        };

        // The owner has to end up on their feet somewhere they could stand.
        let Some(shore) = self.find_shore_point(&position).await else {
            self.send_boat_error(player_id, "Open water — sail closer to shore to pack up.")
                .await;
            return;
        };

        if self.boats.write().await.remove(&boat_id).is_none() {
            return;
        }
        self.apply_player_position(
            player_id,
            shore,
            0.0,
            OVERWORLD_FLOOR,
            ServerMessage::PlayerMoved {
                player_id: *player_id,
                position: shore,
                rotation: 0.0,
                floor_level: OVERWORLD_FLOOR,
            },
        )
        .await;
        self.broadcast_boat(&position, ServerMessage::BoatRemoved { boat_id })
            .await;
        self.send_system_message(player_id, "You haul the boat ashore and roll up the deed.")
            .await;
    }

    /// Probe rings around `origin` (8 compass directions at each distance)
    /// for the first point whose water depth satisfies `wanted`. Returns the
    /// point with `y` set to the water surface there.
    async fn find_nearby_point(
        &self,
        origin: &Position,
        distances: &[f32],
        wanted: impl Fn(f32) -> bool,
    ) -> Option<Position> {
        const DIRS: [(f32, f32); 8] = [
            (0.0, 1.0),
            (
                std::f32::consts::FRAC_1_SQRT_2,
                std::f32::consts::FRAC_1_SQRT_2,
            ),
            (1.0, 0.0),
            (
                std::f32::consts::FRAC_1_SQRT_2,
                -std::f32::consts::FRAC_1_SQRT_2,
            ),
            (0.0, -1.0),
            (
                -std::f32::consts::FRAC_1_SQRT_2,
                -std::f32::consts::FRAC_1_SQRT_2,
            ),
            (-1.0, 0.0),
            (
                -std::f32::consts::FRAC_1_SQRT_2,
                std::f32::consts::FRAC_1_SQRT_2,
            ),
        ];
        for &dist in distances {
            for (ux, uz) in DIRS {
                let x = wrap_world_x(origin.x + ux * dist);
                let z = origin.z + uz * dist;
                match self.water_depth_at(x, z).await {
                    Some((depth, surface, bed)) if wanted(depth) => {
                        let y = if depth > 0.0 { surface } else { bed };
                        return Some(Position { x, y, z });
                    }
                    _ => {}
                }
            }
        }
        None
    }

    /// A point near the hull shallow enough to stand in — where a rider can
    /// step ashore (or the owner can drag the boat out).
    pub(super) async fn find_shore_point(&self, origin: &Position) -> Option<Position> {
        let steps: Vec<f32> = LAUNCH_PROBE_DISTANCES
            .iter()
            .copied()
            .filter(|d| *d <= SHORE_PROBE_RADIUS_M)
            .collect();
        self.find_nearby_point(origin, &steps, |depth| depth < MIN_NAV_DEPTH_M)
            .await
    }

    /// Depth (surface − bed), surface and bed at a point, or `None` when a
    /// tile read fails (treated as "not what you were looking for").
    async fn water_depth_at(&self, x: f32, z: f32) -> Option<(f32, f32, f32)> {
        match (
            self.height_sampler.sample_height(x, z).await,
            self.water_sampler.sample_surface(x, z).await,
        ) {
            (Ok(bed), Ok(surface)) => Some((surface - bed, surface, bed)),
            (Err(err), _) | (_, Err(err)) => {
                warn!("boat water sample failed at ({x:.1}, {z:.1}): {err}");
                None
            }
        }
    }

    /// Boat events go to everyone near the hull on the overworld floor.
    pub(super) async fn broadcast_boat(&self, position: &Position, msg: ServerMessage) {
        self.send_direct_message_to_players_within_position(
            position,
            OVERWORLD_FLOOR,
            super::EVENT_DELIVERY_RADIUS,
            msg,
            None,
        )
        .await;
    }

    pub(super) async fn send_boat_error(&self, player_id: &PlayerId, message: &str) {
        self.send_direct_message(
            player_id,
            ServerMessage::BoatError {
                message: message.to_string(),
            },
        )
        .await;
    }

    /// Handle `ClientMessage::SailTo`: validate the pilot, sample the whole
    /// leg for depth (async, handler-side — the tick never samples), and
    /// replace the boat's route with the watery prefix. A leg whose very
    /// first step is aground earns an error; a later shoal just truncates
    /// the route, and the final `BoatState` shows where the boat stopped.
    pub async fn sail_boat(&self, player_id: &PlayerId, x: f32, z: f32) {
        let (boat_id, boat_pos) = {
            let boats = self.boats.read().await;
            let Some(boat) = boats
                .values()
                .find(|boat| boat.passengers.contains(player_id))
            else {
                self.send_boat_error(player_id, "You are not aboard a boat.")
                    .await;
                return;
            };
            if boat.owner != *player_id {
                self.send_boat_error(player_id, "Only the owner holds the tiller.")
                    .await;
                return;
            }
            (boat.id, boat.position)
        };

        let samples = onlinerpg_shared::boats::leg_sample_points(&boat_pos, x, z);
        if samples.is_empty() {
            return;
        }
        let mut route: VecDeque<Position> = VecDeque::new();
        for (sx, sz) in samples {
            match self.water_depth_at(sx, sz).await {
                Some((depth, surface, _)) if depth > MIN_NAV_DEPTH_M => {
                    route.push_back(Position {
                        x: sx,
                        y: surface,
                        z: sz,
                    });
                }
                _ => break,
            }
        }
        if route.is_empty() {
            self.send_boat_error(player_id, "The way is blocked by land.")
                .await;
            return;
        }

        let state_msg = {
            let mut boats = self.boats.write().await;
            let Some(boat) = boats.get_mut(&boat_id) else {
                return;
            };
            let first = route.front().copied();
            boat.route = route;
            if let Some(first) = first {
                boat.heading = onlinerpg_shared::boats::heading_of(
                    onlinerpg_shared::shortest_world_delta_x(boat.position.x, first.x),
                    first.z - boat.position.z,
                );
            }
            ServerMessage::BoatState {
                boat_id,
                position: boat.position,
                heading: boat.heading,
                sailing: true,
            }
        };
        // Setting sail reels in every line aboard — the fishing abort idiom.
        let passengers = self.boat_passengers(boat_id).await;
        for rider in &passengers {
            self.cancel_fishing_if_active(rider).await;
        }
        self.broadcast_boat(&boat_pos, state_msg).await;
    }

    /// Handle `ClientMessage::StopSailing`: the pilot drops the route where
    /// the boat floats.
    pub async fn stop_sailing(&self, player_id: &PlayerId) {
        let state_msg = {
            let mut boats = self.boats.write().await;
            let Some(boat) = boats
                .values_mut()
                .find(|boat| boat.passengers.contains(player_id))
            else {
                return;
            };
            if boat.owner != *player_id || boat.route.is_empty() {
                return;
            }
            boat.route.clear();
            (
                boat.position,
                ServerMessage::BoatState {
                    boat_id: boat.id,
                    position: boat.position,
                    heading: boat.heading,
                    sailing: false,
                },
            )
        };
        self.broadcast_boat(&state_msg.0, state_msg.1).await;
    }

    /// Everyone aboard a boat, seat order preserved.
    async fn boat_passengers(&self, boat_id: BoatId) -> Vec<PlayerId> {
        self.boats
            .read()
            .await
            .get(&boat_id)
            .map(|boat| boat.passengers.clone())
            .unwrap_or_default()
    }

    /// Advance every boat with a route by `dt` seconds. The routes were
    /// water-validated when accepted, so no sampler is touched here (the
    /// tick rule). Riders' positions follow the hull; their movement is
    /// carried by the one `BoatState` broadcast, never by `PlayerMoved`.
    pub async fn tick_boats(&self, dt: f32) {
        let moved: Vec<(BoatId, Position, Position, f32, bool, Vec<PlayerId>)> = {
            let mut boats = self.boats.write().await;
            if boats.is_empty() {
                return;
            }
            let step = onlinerpg_shared::boats::BOAT_SPEED_MPS * dt.max(0.0);
            let mut moved = Vec::new();
            for boat in boats.values_mut() {
                if boat.route.is_empty() {
                    continue;
                }
                let old_position = boat.position;
                if let Some((new_position, heading)) =
                    onlinerpg_shared::boats::advance_route(&boat.position, &mut boat.route, step)
                {
                    boat.position = new_position;
                    boat.heading = heading;
                    moved.push((
                        boat.id,
                        old_position,
                        new_position,
                        heading,
                        !boat.route.is_empty(),
                        boat.passengers.clone(),
                    ));
                }
            }
            moved
        };

        for (boat_id, old_position, position, heading, sailing, passengers) in moved {
            for rider in &passengers {
                self.carry_rider(rider, &old_position, &position, heading)
                    .await;
            }
            self.broadcast_boat(
                &position,
                ServerMessage::BoatState {
                    boat_id,
                    position,
                    heading,
                    sailing,
                },
            )
            .await;
        }
    }

    /// Move one rider with the hull: position write, spatial-cell move and
    /// the dirty flag for the periodic save — deliberately no `PlayerMoved`
    /// (clients place riders from `BoatState`).
    async fn carry_rider(
        &self,
        player_id: &PlayerId,
        old_position: &Position,
        new_position: &Position,
        heading: f32,
    ) {
        {
            let mut players = self.players.write().await;
            let Some(player) = players.get_mut(player_id) else {
                return;
            };
            player.position = *new_position;
            player.rotation = heading;
        }
        self.move_player_spatial_cell(player_id, old_position, new_position)
            .await;
        self.mark_dirty(player_id).await;
    }
}

// Referenced by later stages (boarding fills seats up to BOAT_SEATS).
const _: () = assert!(BOAT_SEATS >= 2, "a boat you cannot share is a canoe");
