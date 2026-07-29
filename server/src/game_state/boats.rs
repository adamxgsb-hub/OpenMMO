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
}

// Referenced by later stages (boarding fills seats up to BOAT_SEATS).
const _: () = assert!(BOAT_SEATS >= 2, "a boat you cannot share is a canoe");
