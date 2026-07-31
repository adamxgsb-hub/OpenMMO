//! Server-side ore-vein lookup, the third sampler beside `HeightSampler`
//! and `WaterSampler`. Veins are not stored anywhere: they are a pure
//! function of a tile's baked splatmap + heightmap bytes
//! (`onlinerpg_shared::worldgen::ore_nodes`), so this index just reads the
//! two tile files and caches the derived node list. A tile with no baked
//! data derives from the default (empty) maps and yields no veins.
//!
//! Reads happen only in async handlers (the `MiningStart` path), never in
//! the mining tick — the first-touch tile IO rule the other samplers follow.

use std::collections::HashMap;
use std::sync::Arc;

use onlinerpg_shared::worldgen::ore_nodes::{ore_nodes_for_tile, OreNode};

use crate::coords::wrap_tile_x;
use crate::io::TerrainIO;

/// Where the raw tile bytes come from — the local data directory on the
/// game server, or a fake in tests.
#[async_trait::async_trait]
pub trait OreTiles: Send + Sync {
    async fn read_splatmap(&self, tx: i32, tz: i32) -> std::io::Result<Vec<u8>>;
    async fn read_heightmap(&self, tx: i32, tz: i32) -> std::io::Result<Vec<u8>>;
}

#[async_trait::async_trait]
impl OreTiles for TerrainIO {
    async fn read_splatmap(&self, tx: i32, tz: i32) -> std::io::Result<Vec<u8>> {
        TerrainIO::read_splatmap(self, tx, tz).await
    }

    async fn read_heightmap(&self, tx: i32, tz: i32) -> std::io::Result<Vec<u8>> {
        TerrainIO::read_heightmap(self, tx, tz).await
    }
}

/// Derives and caches per-tile ore-vein lists. Interior mutability (like
/// the other samplers) so callers hold only `&self`. The cache is
/// derive-once: terrain tiles are immutable at runtime outside the map
/// editor, and a stale editor edit costs at worst one phantom/missing vein
/// until restart.
pub struct OreNodeIndex {
    cache: tokio::sync::RwLock<HashMap<(i32, i32), Arc<Vec<OreNode>>>>,
    tiles: Box<dyn OreTiles>,
}

impl OreNodeIndex {
    pub fn new(tiles: impl OreTiles + 'static) -> Self {
        Self {
            cache: tokio::sync::RwLock::new(HashMap::new()),
            tiles: Box::new(tiles),
        }
    }

    /// The deterministic vein list for a tile (X wrapped into the cylinder).
    pub async fn nodes_for_tile(&self, tx: i32, tz: i32) -> std::io::Result<Arc<Vec<OreNode>>> {
        let key = (wrap_tile_x(tx), tz);
        if let Some(nodes) = self.cache.read().await.get(&key) {
            return Ok(Arc::clone(nodes));
        }
        let splat = self.tiles.read_splatmap(key.0, key.1).await?;
        let height = self.tiles.read_heightmap(key.0, key.1).await?;
        let nodes = Arc::new(ore_nodes_for_tile(key.0, key.1, &splat, &height));
        self.cache.write().await.insert(key, Arc::clone(&nodes));
        Ok(nodes)
    }
}
