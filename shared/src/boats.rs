//! Boat protocol types and tuning constants (design: `doc/BOATS.md`).
//! Shared so the server (authority), the web client (rendering), and the
//! agent-client (the `sail` action) all read the same shapes and speeds.
//! The server owns the boat's position, route and every rider aboard —
//! clients only render the hull and ask for destinations.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::entity::PlayerId;
use crate::world::{shortest_world_delta_x, wrap_world_x, Position};

/// Server-minted boat identity. A plain counter like ground-item instance
/// ids — boats live only while afloat (the deed in the bag is the durable
/// object), so ids never persist and never repeat within a server run.
pub type BoatId = u64;

/// One rider and the seat they hold. Seat 0 is the helm (the owner).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoatPassenger {
    pub player_id: PlayerId,
    pub seat: u8,
}

/// A boat as broadcast in `ServerMessage::BoatSpawned` — everything a
/// client needs to render it and its riders from a standing start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoatSnapshot {
    pub id: BoatId,
    pub owner: PlayerId,
    /// Hull position; `y` is the sampled water surface.
    pub position: Position,
    /// Facing, radians, `heading_of` convention.
    pub heading: f32,
    pub passengers: Vec<BoatPassenger>,
}

/// Sailing speed, meters per second — twice walking pace
/// (`world::PLAYER_MOVE_SPEED`), so travel by water feels like a real
/// upgrade without outrunning the 200 ms boat tick.
pub const BOAT_SPEED_MPS: f32 = 6.0;

/// Longest single `SailTo` leg the server accepts, mirroring the walking
/// sim's `MAX_MOVE_TARGET_DISTANCE`. Longer clicks are clamped, not
/// refused — sail again to continue.
pub const MAX_SAIL_LEG_M: f32 = 60.0;

/// Water-depth sampling interval along a requested leg. At 2 m no strip of
/// land wider than a footpath can slip between samples.
pub const SAIL_SAMPLE_STEP_M: f32 = 2.0;

/// Minimum water depth (surface − bed) a hull needs. Deliberately deeper
/// than fishing's 0.1 m castable fringe: a bobber floats where a keel
/// grounds.
pub const MIN_NAV_DEPTH_M: f32 = 0.3;

/// How close a player must stand to a hull to climb aboard (XZ meters).
pub const BOARD_RADIUS_M: f32 = 3.0;

/// Seats per boat, helm included.
pub const BOAT_SEATS: usize = 4;

/// How far around the hull the server probes for a dry landing when a
/// rider steps ashore (or the owner packs the boat up).
pub const SHORE_PROBE_RADIUS_M: f32 = 6.0;

/// Facing, radians, from a movement delta — `atan2(dx, dz)`, the same
/// convention the client's character models use for rotation.
pub fn heading_of(dx: f32, dz: f32) -> f32 {
    if dx == 0.0 && dz == 0.0 {
        return 0.0;
    }
    dx.atan2(dz)
}

/// Sample points along a straight sail leg, every `SAIL_SAMPLE_STEP_M`,
/// endpoint always included, X wrapped onto the cylindrical world. The leg
/// is clamped to `MAX_SAIL_LEG_M` toward the target. Returns an empty list
/// when the target is (effectively) where the boat already floats.
pub fn leg_sample_points(from: &Position, to_x: f32, to_z: f32) -> Vec<(f32, f32)> {
    let dx = shortest_world_delta_x(from.x, wrap_world_x(to_x));
    let dz = to_z - from.z;
    let length = (dx * dx + dz * dz).sqrt();
    if length < SAIL_SAMPLE_STEP_M * 0.5 {
        return Vec::new();
    }
    let clamped = length.min(MAX_SAIL_LEG_M);
    let (ux, uz) = (dx / length, dz / length);
    let mut points = Vec::new();
    let mut travelled = SAIL_SAMPLE_STEP_M;
    while travelled < clamped {
        points.push((
            wrap_world_x(from.x + ux * travelled),
            from.z + uz * travelled,
        ));
        travelled += SAIL_SAMPLE_STEP_M;
    }
    points.push((wrap_world_x(from.x + ux * clamped), from.z + uz * clamped));
    points
}

/// Advance a boat along its validated route by up to `step` meters, eating
/// through waypoints the way the walking sim eats `MoveIntent`s — one tick
/// budget can span several short segments. Waypoint `y` values are the
/// pre-sampled water surface, interpolated along each segment so the hull
/// rides the river up and down. Returns the new position and the heading of
/// the last segment travelled, or `None` when there was no route to follow.
pub fn advance_route(
    position: &Position,
    route: &mut VecDeque<Position>,
    step: f32,
) -> Option<(Position, f32)> {
    let mut pos = *position;
    let mut budget = step.max(0.0);
    let mut heading = None;
    while budget > 0.0 {
        let Some(target) = route.front().copied() else {
            break;
        };
        let dx = shortest_world_delta_x(pos.x, target.x);
        let dz = target.z - pos.z;
        let dist = (dx * dx + dz * dz).sqrt();
        if dist <= budget {
            pos = target;
            route.pop_front();
            budget -= dist;
            if dist > f32::EPSILON {
                heading = Some(heading_of(dx, dz));
            }
        } else {
            let t = budget / dist;
            pos.x = wrap_world_x(pos.x + dx * t);
            pos.z += dz * t;
            pos.y += (target.y - pos.y) * t;
            heading = Some(heading_of(dx, dz));
            budget = 0.0;
        }
    }
    heading.map(|h| (pos, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{WORLD_MAX_X, WORLD_MIN_X};

    fn at(x: f32, z: f32) -> Position {
        Position { x, y: 0.0, z }
    }

    #[test]
    fn leg_samples_step_the_line_and_always_end_on_the_target() {
        let points = leg_sample_points(&at(0.0, 0.0), 0.0, 10.0);
        assert_eq!(points.len(), 5, "2m steps, endpoint included");
        assert_eq!(points.last(), Some(&(0.0, 10.0)));
        // A click on the hull itself asks for nothing.
        assert!(leg_sample_points(&at(0.0, 0.0), 0.0, 0.4).is_empty());
    }

    #[test]
    fn a_long_leg_is_clamped_not_refused() {
        let points = leg_sample_points(&at(0.0, 0.0), 0.0, 500.0);
        let (_, end_z) = *points.last().unwrap();
        assert!((end_z - MAX_SAIL_LEG_M).abs() < 1e-3);
    }

    #[test]
    fn legs_cross_the_world_seam_the_short_way() {
        let points = leg_sample_points(&at(WORLD_MAX_X - 4.0, 0.0), WORLD_MIN_X + 4.0, 0.0);
        let (end_x, _) = *points.last().unwrap();
        assert!(
            (end_x - (WORLD_MIN_X + 4.0)).abs() < 1e-2,
            "an 8m hop, not a lap of the world: ended at {end_x}"
        );
        for (x, _) in &points {
            assert!(
                (WORLD_MIN_X..WORLD_MAX_X).contains(x),
                "unwrapped sample {x}"
            );
        }
    }

    #[test]
    fn advancing_spends_one_budget_across_queued_waypoints() {
        let mut route: VecDeque<Position> = [at(0.0, 1.0), at(0.0, 2.0), at(0.0, 10.0)]
            .into_iter()
            .collect();
        let (pos, heading) = advance_route(&at(0.0, 0.0), &mut route, 3.0).unwrap();
        assert!((pos.z - 3.0).abs() < 1e-4);
        assert_eq!(route.len(), 1, "two waypoints consumed, third in progress");
        assert!(heading.abs() < 1e-4, "due +Z is heading 0");
        assert!(advance_route(&pos, &mut VecDeque::new(), 3.0).is_none());
    }

    #[test]
    fn the_hull_rides_the_surface_between_waypoints() {
        let mut route: VecDeque<Position> = [Position {
            x: 0.0,
            y: 2.0,
            z: 10.0,
        }]
        .into_iter()
        .collect();
        let (pos, _) = advance_route(&at(0.0, 0.0), &mut route, 5.0).unwrap();
        assert!((pos.y - 1.0).abs() < 1e-4, "halfway there, half the rise");
    }

    #[test]
    fn headings_point_where_the_boat_goes() {
        assert!((heading_of(0.0, 1.0) - 0.0).abs() < 1e-6);
        assert!((heading_of(1.0, 0.0) - std::f32::consts::FRAC_PI_2).abs() < 1e-6);
        assert_eq!(heading_of(0.0, 0.0), 0.0);
    }
}
