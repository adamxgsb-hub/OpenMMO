use std::io;

use crate::{coords, io::TerrainIO};
use onlinerpg_shared::tree_format::{
    TREE_V1_BYTES_PER_INSTANCE, TREE_V1_HEADER_BYTES, TREE_V1_MAGIC, TREE_V1_SCALE,
};

const TILE_SIZE: f32 = crate::defaults::TILE_DIM as f32;

/// Axis-aligned exclusion rect [min_x, min_z, max_x, max_z] in world coords.
pub type TreeExclusionRect = [f32; 4];

#[derive(Debug)]
pub struct TreeRemovalStats {
    pub tiles_changed: usize,
    pub trees_removed: usize,
    pub changed_tiles: Vec<(i32, i32)>,
}

fn invalid_tree_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn tile_min_world(tile: i32) -> f32 {
    tile as f32 * TILE_SIZE - TILE_SIZE * 0.5
}

fn read_u32_le(data: &[u8], offset: usize) -> io::Result<u32> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or_else(|| invalid_tree_data("tree data header is truncated"))?;
    Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
}

fn should_remove_tree(
    tile_x: i32,
    tile_z: i32,
    instance: &[u8],
    exclusion_rects: &[TreeExclusionRect],
) -> io::Result<bool> {
    let local_x = u16::from_le_bytes(
        instance[0..2]
            .try_into()
            .map_err(|_| invalid_tree_data("tree instance is truncated"))?,
    ) as f32
        * TILE_SIZE
        / 65535.0;
    let local_z = u16::from_le_bytes(
        instance[2..4]
            .try_into()
            .map_err(|_| invalid_tree_data("tree instance is truncated"))?,
    ) as f32
        * TILE_SIZE
        / 65535.0;
    let world_x = tile_min_world(tile_x) + local_x;
    let world_z = tile_min_world(tile_z) + local_z;

    Ok(exclusion_rects.iter().any(|[min_x, min_z, max_x, max_z]| {
        world_x >= *min_x && world_x <= *max_x && world_z >= *min_z && world_z <= *max_z
    }))
}

/// One decoded tree instance in world XZ coordinates. Y is deliberately
/// absent — TR01 doesn't store it and the server's tree consumers
/// (woodcutting) sample the heightmap themselves when they need it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TreeInstance {
    pub world_x: f32,
    pub world_z: f32,
    pub rotation: f32,
    pub scale: f32,
}

/// Decode a tile's V1 tree bytes into per-slot instance lists (slot 0 =
/// `tree.glb`, slot 1 = `tree2.glb`). Must stay bit-for-bit consistent with
/// the TypeScript decoder in `client/src/lib/utils/tree-data.ts`
/// (`decodeTreeData`): both sides address a tree as (tile, slot, index into
/// the slot's array), so a divergent decode would point at the wrong tree.
pub fn decode_tree_v1_bytes(
    tile_x: i32,
    tile_z: i32,
    data: &[u8],
) -> io::Result<[Vec<TreeInstance>; 2]> {
    if data.len() < TREE_V1_HEADER_BYTES {
        return Err(invalid_tree_data("tree data header is truncated"));
    }
    let magic = read_u32_le(data, 0)?;
    if magic != TREE_V1_MAGIC {
        return Err(invalid_tree_data(format!(
            "unsupported tree data magic 0x{magic:08x}"
        )));
    }
    let counts = [
        read_u32_le(data, 4)? as usize,
        read_u32_le(data, 8)? as usize,
    ];
    let expected_len = TREE_V1_HEADER_BYTES + (counts[0] + counts[1]) * TREE_V1_BYTES_PER_INSTANCE;
    if data.len() != expected_len {
        return Err(invalid_tree_data(format!(
            "tree data length mismatch: expected {expected_len}, got {}",
            data.len()
        )));
    }

    let min_x = tile_min_world(tile_x);
    let min_z = tile_min_world(tile_z);
    let mut out = [Vec::with_capacity(counts[0]), Vec::with_capacity(counts[1])];
    let mut offset = TREE_V1_HEADER_BYTES;
    for (slot, count) in counts.into_iter().enumerate() {
        let (scale_min, scale_range) = TREE_V1_SCALE[slot];
        for _ in 0..count {
            let local_x = u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap()) as f32
                * TILE_SIZE
                / 65535.0;
            let local_z = u16::from_le_bytes(data[offset + 2..offset + 4].try_into().unwrap())
                as f32
                * TILE_SIZE
                / 65535.0;
            let rotation = data[offset + 4] as f32 * std::f32::consts::TAU / 255.0;
            let scale = scale_min + data[offset + 5] as f32 * scale_range / 255.0;
            out[slot].push(TreeInstance {
                world_x: min_x + local_x,
                world_z: min_z + local_z,
                rotation,
                scale,
            });
            offset += TREE_V1_BYTES_PER_INSTANCE;
        }
    }
    Ok(out)
}

/// Where baked tree tiles come from: the local data directory on the game
/// server, something else in tests. Same shape as `HeightTiles`/`WaterTiles`.
#[async_trait::async_trait]
pub trait TreeTiles: Send + Sync {
    /// Raw TR01 bytes for one tile, or `None` where nothing was baked.
    async fn read_trees(&self, tx: i32, tz: i32) -> io::Result<Option<Vec<u8>>>;
}

#[async_trait::async_trait]
impl TreeTiles for TerrainIO {
    async fn read_trees(&self, tx: i32, tz: i32) -> io::Result<Option<Vec<u8>>> {
        TerrainIO::read_trees(self, tx, tz).await
    }
}

/// Decoded read access to baked tree tiles. Deliberately cache-free, unlike
/// `HeightSampler`: tree tiles are tiny, reads are rare (one chop start),
/// and housing placement rewrites tiles at runtime — an uninvalidated cache
/// would point choppers at trees that were pruned from under a new house.
pub struct TreeReader {
    tiles: Box<dyn TreeTiles>,
}

impl TreeReader {
    pub fn new(tiles: impl TreeTiles + 'static) -> Self {
        Self {
            tiles: Box::new(tiles),
        }
    }

    /// Decoded instances for one tile, per model slot. A tile with no baked
    /// tree data reads as empty rather than an error — the world is larger
    /// than the baked area.
    pub async fn tile_instances(&self, tx: i32, tz: i32) -> io::Result<[Vec<TreeInstance>; 2]> {
        match self.tiles.read_trees(tx, tz).await? {
            Some(data) => decode_tree_v1_bytes(tx, tz, &data),
            None => Ok([Vec::new(), Vec::new()]),
        }
    }
}

/// Filter V1 tree placement data by world-space exclusion rectangles.
///
/// Returns `Ok(None)` when no tree instances were removed.
pub fn filter_tree_v1_bytes_in_rects(
    tile_x: i32,
    tile_z: i32,
    data: &[u8],
    exclusion_rects: &[TreeExclusionRect],
) -> io::Result<Option<(Vec<u8>, usize)>> {
    if exclusion_rects.is_empty() {
        return Ok(None);
    }
    if data.len() < TREE_V1_HEADER_BYTES {
        return Err(invalid_tree_data("tree data header is truncated"));
    }

    let magic = read_u32_le(data, 0)?;
    if magic != TREE_V1_MAGIC {
        return Err(invalid_tree_data(format!(
            "unsupported tree data magic 0x{magic:08x}"
        )));
    }

    let original_counts = [
        read_u32_le(data, 4)? as usize,
        read_u32_le(data, 8)? as usize,
    ];
    let total = original_counts[0] + original_counts[1];
    let expected_len = TREE_V1_HEADER_BYTES + total * TREE_V1_BYTES_PER_INSTANCE;
    if data.len() != expected_len {
        return Err(invalid_tree_data(format!(
            "tree data length mismatch: expected {expected_len}, got {}",
            data.len()
        )));
    }

    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&TREE_V1_MAGIC.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    let mut kept_counts = [0usize, 0usize];
    let mut removed = 0usize;
    let mut offset = TREE_V1_HEADER_BYTES;
    for tree_type in 0..2 {
        for _ in 0..original_counts[tree_type] {
            let instance = &data[offset..offset + TREE_V1_BYTES_PER_INSTANCE];
            offset += TREE_V1_BYTES_PER_INSTANCE;
            if should_remove_tree(tile_x, tile_z, instance, exclusion_rects)? {
                removed += 1;
                continue;
            }
            kept_counts[tree_type] += 1;
            out.extend_from_slice(instance);
        }
    }

    if removed == 0 {
        return Ok(None);
    }

    out[4..8].copy_from_slice(&(kept_counts[0] as u32).to_le_bytes());
    out[8..12].copy_from_slice(&(kept_counts[1] as u32).to_le_bytes());
    Ok(Some((out, removed)))
}

fn rect_to_tile_bounds([min_x, min_z, max_x, max_z]: TreeExclusionRect) -> (i32, i32, i32, i32) {
    (
        coords::world_to_tile(min_x),
        coords::world_to_tile(max_x),
        coords::world_to_tile(min_z),
        coords::world_to_tile(max_z),
    )
}

/// Remove tree instances in the given rects from persisted terrain tree tiles.
pub async fn remove_trees_in_rects(
    terrain: &TerrainIO,
    exclusion_rects: &[TreeExclusionRect],
) -> io::Result<TreeRemovalStats> {
    let mut stats = TreeRemovalStats {
        tiles_changed: 0,
        trees_removed: 0,
        changed_tiles: Vec::new(),
    };

    // Union of all tiles touched by any rect — rooms in a house routinely share
    // a tile, so read/filter/write each tile at most once against the full rect
    // set instead of re-reading the just-written file per rect.
    let mut tiles: Vec<(i32, i32)> = Vec::new();
    for &rect in exclusion_rects {
        let (tile_min_x, tile_max_x, tile_min_z, tile_max_z) = rect_to_tile_bounds(rect);
        for tile_z in tile_min_z..=tile_max_z {
            for tile_x in tile_min_x..=tile_max_x {
                if !tiles.contains(&(tile_x, tile_z)) {
                    tiles.push((tile_x, tile_z));
                }
            }
        }
    }

    for (tile_x, tile_z) in tiles {
        let Some(data) = terrain.read_trees(tile_x, tile_z).await? else {
            continue;
        };
        let Some((filtered, removed)) =
            filter_tree_v1_bytes_in_rects(tile_x, tile_z, &data, exclusion_rects)?
        else {
            continue;
        };
        terrain.write_trees(tile_x, tile_z, &filtered).await?;
        stats.tiles_changed += 1;
        stats.trees_removed += removed;
        stats.changed_tiles.push((tile_x, tile_z));
    }

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree_data(instances: &[(u16, u16)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&TREE_V1_MAGIC.to_le_bytes());
        out.extend_from_slice(&(instances.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for &(x, z) in instances {
            out.extend_from_slice(&x.to_le_bytes());
            out.extend_from_slice(&z.to_le_bytes());
            out.push(0);
            out.push(0);
        }
        out
    }

    #[test]
    fn filters_tree_instances_inside_world_rect() {
        let data = tree_data(&[(32768, 32768), (65535, 65535)]);
        let filtered = filter_tree_v1_bytes_in_rects(0, 0, &data, &[[-1.0, -1.0, 1.0, 1.0]])
            .expect("valid tree data")
            .expect("one tree should be removed");

        assert_eq!(filtered.1, 1);
        assert_eq!(read_u32_le(&filtered.0, 4).unwrap(), 1);
        assert_eq!(read_u32_le(&filtered.0, 8).unwrap(), 0);
        assert_eq!(
            filtered.0.len(),
            TREE_V1_HEADER_BYTES + TREE_V1_BYTES_PER_INSTANCE
        );
    }

    #[test]
    fn decode_matches_the_client_formulas() {
        // One instance per slot: slot 0 at the exact tile center with the
        // scale byte maxed, slot 1 at the tile max corner with rotation
        // byte maxed. The expectations are the client decoder's formulas
        // (tree-data.ts) evaluated by hand.
        let mut data = Vec::new();
        data.extend_from_slice(&TREE_V1_MAGIC.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&32768u16.to_le_bytes());
        data.extend_from_slice(&32768u16.to_le_bytes());
        data.push(0);
        data.push(255);
        data.extend_from_slice(&65535u16.to_le_bytes());
        data.extend_from_slice(&65535u16.to_le_bytes());
        data.push(255);
        data.push(0);

        let [slot0, slot1] = decode_tree_v1_bytes(1, -1, &data).expect("valid tree data");
        assert_eq!(slot0.len(), 1);
        assert_eq!(slot1.len(), 1);
        // Tile 1 spans [32, 96); u16 32768 ≈ half the tile.
        let t0 = slot0[0];
        assert!((t0.world_x - (32.0 + 32768.0 * TILE_SIZE / 65535.0)).abs() < 1e-3);
        assert!((t0.world_z - (-96.0 + 32768.0 * TILE_SIZE / 65535.0)).abs() < 1e-3);
        assert_eq!(t0.rotation, 0.0);
        // Scale byte 255 → slot 0 max: 0.7 + 2.3.
        assert!((t0.scale - (TREE_V1_SCALE[0].0 + TREE_V1_SCALE[0].1)).abs() < 1e-4);
        let t1 = slot1[0];
        assert!((t1.world_x - 96.0).abs() < 1e-3);
        assert!((t1.rotation - std::f32::consts::TAU).abs() < 0.03);
        // Scale byte 0 → slot 1 min: 0.6.
        assert!((t1.scale - TREE_V1_SCALE[1].0).abs() < 1e-4);
    }

    #[test]
    fn decode_rejects_bad_magic_and_truncation() {
        assert!(decode_tree_v1_bytes(0, 0, &[0u8; 4]).is_err());
        let mut bad_magic = tree_data(&[(0, 0)]);
        bad_magic[0] ^= 0xff;
        assert!(decode_tree_v1_bytes(0, 0, &bad_magic).is_err());
        let mut truncated = tree_data(&[(0, 0)]);
        truncated.pop();
        assert!(decode_tree_v1_bytes(0, 0, &truncated).is_err());
    }

    #[test]
    fn returns_none_when_no_instances_match() {
        let data = tree_data(&[(65535, 65535)]);
        let filtered = filter_tree_v1_bytes_in_rects(0, 0, &data, &[[-1.0, -1.0, 1.0, 1.0]])
            .expect("valid tree data");

        assert!(filtered.is_none());
    }
}
