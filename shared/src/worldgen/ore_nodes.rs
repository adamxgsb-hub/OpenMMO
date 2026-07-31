//! Deterministic ore-vein placement over already-baked terrain tiles.
//!
//! There is no ore layer in the bake and none is needed: a vein's existence
//! is a pure function of a tile's splatmap + heightmap bytes. The splat
//! baker already classifies exposed rock (`PAL_CLIFF` on ≥45° slopes), so
//! "where can ore be?" is exactly "where did the world bake cliffs?" —
//! mountains and gorge walls, never meadows (cliff cells carry `vegMeta 0`,
//! so veins and trees occupy complementary terrain by construction).
//!
//! This is the river-rock idiom (`client/src/lib/utils/river-rock-placement.ts`
//! derives decorative rocks from baked water-field bytes, no extra artifact
//! or message) promoted to gameplay: the server derives the same node list
//! for validation, the web client via wasm for rendering and clicking, and
//! the agent-client natively for its `mine` action. Same bytes in, same
//! veins out, on every surface — parity by construction, and it works on
//! every already-baked world with no re-bake or migration.

use super::tile_bake::{PAL_CLIFF, TILE_DIM};
use super::vegetation::{decode_heightmap, sample_height, tile_min_world, Rng};
use serde::{Deserialize, Serialize};

/// Per-cell probability that an eligible (cliff) cell tries to host a vein.
///
/// Calibrated against a real bake (seed 7, regions x[4,8] z[12,15]), not
/// guessed: a mountain tile is not "rock here and there" but *almost
/// entirely* rock — the median rocky tile carries 4072 of its 4096 cells.
/// So this has to be tiny. It lands ~1.2 veins on a rocky tile, ore on
/// ~1 tile in 5 of mountain terrain and none at all on the coast, or one
/// vein roughly every 135 m of rock — far enough that ore is worth
/// climbing for, close enough that prospecting is not a chore. Re-measure
/// with `ore_calibration.rs` after any worldgen change.
const ORE_NODE_PROBABILITY: f64 = 0.0001;

/// Minimum XZ distance between two veins in the same tile. (Cross-tile
/// pairs can undercut this at borders; accepted, they're still distinct
/// nodes with distinct keys.)
const MIN_NODE_SPACING_M: f32 = 8.0;

/// Hard cap per tile so a sheer cliff wall doesn't become a quarry.
pub const MAX_NODES_PER_TILE: usize = 5;

/// A partially-rocky cell (cliff as secondary texture) qualifies once the
/// blend is at least this strong — the fade apron around a cliff face,
/// which is where a vein is actually reachable on foot.
const CLIFF_SECONDARY_MIN_BLEND: u8 = 64;

/// Veins never spawn underwater (matches the tree rule).
const MIN_WORLD_Y: f32 = 0.5;

/// How many rock model variants clients may render (`river_rock_01..03`).
pub const ORE_NODE_VARIANTS: u8 = 3;

/// One placed ore vein, fully derived from tile bytes. Positions are world
/// coordinates; `index` is the node's position in the tile's deterministic
/// list and, with the tile coords, its wire identity (`mining::OreNodeKey`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OreNode {
    pub index: u16,
    pub world_x: f32,
    pub world_y: f32,
    pub world_z: f32,
    /// Render rotation, radians.
    pub rotation: f32,
    /// Render scale multiplier.
    pub scale: f32,
    /// Which rock model to render (0..ORE_NODE_VARIANTS).
    pub variant: u8,
    /// Total ore this vein yields before crumbling (2–5).
    pub yield_total: u8,
}

/// `((tx * 15485863) ^ (tz * 32452843)) | 0` — the tree/grass tile-seed
/// pattern with its own prime pair so ore never correlates with vegetation.
fn tile_seed_ore(tx: i32, tz: i32) -> i32 {
    tx.wrapping_mul(15_485_863) ^ tz.wrapping_mul(32_452_843)
}

const CHANNELS: usize = 4;
const BLEND_OFFSET: usize = 2;

/// Is this splat cell exposed or near-exposed rock? Primary cliff texture,
/// or cliff bleeding in as secondary at a meaningful blend.
fn is_rocky_cell(splatmap: &[u8], cx: usize, cz: usize) -> bool {
    let base = (cz * TILE_DIM + cx) * CHANNELS;
    let b0 = splatmap[base];
    let primary = b0 >> 4;
    let secondary = b0 & 0x0F;
    primary == PAL_CLIFF
        || (secondary == PAL_CLIFF && splatmap[base + BLEND_OFFSET] >= CLIFF_SECONDARY_MIN_BLEND)
}

/// The deterministic node list for one tile. Same splat/height bytes in,
/// same nodes out — every consumer (server, wasm client, agent-client)
/// calls exactly this. Scan order (z-major, like the tree bake) fixes the
/// node indices; the spacing filter keeps whichever node scanned first.
pub fn ore_nodes_for_tile(
    tx: i32,
    tz: i32,
    splatmap: &[u8],
    heightmap_bytes: &[u8],
) -> Vec<OreNode> {
    let heights = decode_heightmap(heightmap_bytes);
    let tile_min_x = tile_min_world(tx);
    let tile_min_z = tile_min_world(tz);
    let mut rng = Rng::new(tile_seed_ore(tx, tz));

    let mut nodes: Vec<OreNode> = Vec::new();
    for cz in 0..TILE_DIM {
        for cx in 0..TILE_DIM {
            if !is_rocky_cell(splatmap, cx, cz) {
                continue;
            }
            // The roll must happen for every eligible cell — skipping it
            // after the cap would shift later draws and break determinism
            // against partial evaluation. Draw first, then filter.
            if rng.next_f64() >= ORE_NODE_PROBABILITY {
                continue;
            }
            let local_x = cx as f32 + (rng.next_f64() as f32) * 0.8 + 0.1;
            let local_z = cz as f32 + (rng.next_f64() as f32) * 0.8 + 0.1;
            let rotation = (rng.next_f64() as f32) * std::f32::consts::TAU;
            let scale = 0.9 + (rng.next_f64() as f32) * 0.5;
            let variant = (rng.next_f64() * f64::from(ORE_NODE_VARIANTS)) as u8;
            let yield_total = 2 + (rng.next_f64() * 4.0) as u8;

            if nodes.len() >= MAX_NODES_PER_TILE {
                continue;
            }
            let world_y = sample_height(&heights, local_x, local_z);
            if world_y < MIN_WORLD_Y {
                continue;
            }
            let world_x = tile_min_x + local_x;
            let world_z = tile_min_z + local_z;
            let too_close = nodes.iter().any(|n| {
                let dx = n.world_x - world_x;
                let dz = n.world_z - world_z;
                dx * dx + dz * dz < MIN_NODE_SPACING_M * MIN_NODE_SPACING_M
            });
            if too_close {
                continue;
            }

            nodes.push(OreNode {
                index: nodes.len() as u16,
                world_x,
                world_y,
                world_z,
                rotation,
                scale,
                variant: variant.min(ORE_NODE_VARIANTS - 1),
                yield_total,
            });
        }
    }
    nodes
}

#[cfg(test)]
mod tests {
    use super::super::tile_bake::{HEIGHT_BIAS, HEIGHT_STEP, VERTS_PER_SIDE};
    use super::*;

    /// Flat heightmap at `y` meters, encoded like the bake writes it.
    fn flat_heightmap(y: f32) -> Vec<u8> {
        let v = ((y + HEIGHT_BIAS) / HEIGHT_STEP) as u16;
        let mut out = Vec::with_capacity(VERTS_PER_SIDE * VERTS_PER_SIDE * 2);
        for _ in 0..VERTS_PER_SIDE * VERTS_PER_SIDE {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    fn splat_all(primary: u8) -> Vec<u8> {
        let mut out = vec![0u8; TILE_DIM * TILE_DIM * CHANNELS];
        for cell in out.chunks_exact_mut(CHANNELS) {
            cell[0] = primary << 4;
        }
        out
    }

    #[test]
    fn same_bytes_same_nodes() {
        let splat = splat_all(PAL_CLIFF);
        let height = flat_heightmap(40.0);
        let a = ore_nodes_for_tile(7, -3, &splat, &height);
        let b = ore_nodes_for_tile(7, -3, &splat, &height);
        assert!(!a.is_empty(), "an all-cliff tile must produce nodes");
        assert_eq!(a, b);
    }

    #[test]
    fn different_tiles_differ() {
        let splat = splat_all(PAL_CLIFF);
        let height = flat_heightmap(40.0);
        let a = ore_nodes_for_tile(7, -3, &splat, &height);
        let b = ore_nodes_for_tile(8, -3, &splat, &height);
        assert_ne!(a, b, "tile seed must vary placements");
    }

    #[test]
    fn no_ore_off_the_rock() {
        let height = flat_heightmap(40.0);
        for palette in [0u8, 1, 2, 3, 4, 6, 7, 8] {
            let splat = splat_all(palette);
            assert!(
                ore_nodes_for_tile(0, 0, &splat, &height).is_empty(),
                "palette {palette} must not host ore"
            );
        }
    }

    #[test]
    fn secondary_cliff_needs_a_real_blend() {
        let height = flat_heightmap(40.0);
        // Cliff as secondary with a whisper of blend: not rocky enough.
        let mut faint = vec![0u8; TILE_DIM * TILE_DIM * CHANNELS];
        for cell in faint.chunks_exact_mut(CHANNELS) {
            cell[0] = PAL_CLIFF; // primary 0 (ground), secondary cliff
            cell[BLEND_OFFSET] = CLIFF_SECONDARY_MIN_BLEND - 1;
        }
        assert!(ore_nodes_for_tile(0, 0, &faint, &height).is_empty());
        // Same layout at the threshold: rocky.
        for cell in faint.chunks_exact_mut(CHANNELS) {
            cell[BLEND_OFFSET] = CLIFF_SECONDARY_MIN_BLEND;
        }
        assert!(!ore_nodes_for_tile(7, -3, &faint, &height).is_empty());
    }

    #[test]
    fn no_ore_underwater() {
        let splat = splat_all(PAL_CLIFF);
        let height = flat_heightmap(-5.0);
        assert!(ore_nodes_for_tile(7, -3, &splat, &height).is_empty());
    }

    #[test]
    fn nodes_respect_cap_spacing_and_ranges() {
        let splat = splat_all(PAL_CLIFF);
        let height = flat_heightmap(40.0);
        for seed_tile in 0..32 {
            let nodes = ore_nodes_for_tile(seed_tile, seed_tile * 3 - 11, &splat, &height);
            assert!(nodes.len() <= MAX_NODES_PER_TILE);
            for (i, n) in nodes.iter().enumerate() {
                assert_eq!(usize::from(n.index), i, "indices are list positions");
                assert!((2..=5).contains(&n.yield_total));
                assert!(n.variant < ORE_NODE_VARIANTS);
                assert!((0.9..=1.4).contains(&n.scale));
                for m in &nodes[i + 1..] {
                    let dx = n.world_x - m.world_x;
                    let dz = n.world_z - m.world_z;
                    assert!(
                        dx * dx + dz * dz >= MIN_NODE_SPACING_M * MIN_NODE_SPACING_M,
                        "spacing floor violated"
                    );
                }
            }
        }
    }
}
