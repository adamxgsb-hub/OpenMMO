//! Ore-density calibration probe against a real baked world.
//!
//! Vein placement is tuned by two numbers in
//! `worldgen::ore_nodes` — `ORE_NODE_PROBABILITY` and `MAX_NODES_PER_TILE` —
//! and their effect only means anything against real baked terrain, whose
//! cliff coverage the synthetic test tiles cannot imitate. This walks a
//! baked `data/terrain` and reports what mining would actually find
//! (doc/MINING.md).
//!
//! Ignored by default: `data/terrain` is generated, not committed, so CI has
//! no tiles to read. Re-run it after any worldgen or tuning change:
//!
//! ```text
//! cargo test -p onlinerpg-terrain --  --ignored --nocapture ore_density
//! ```

#[cfg(test)]
mod tests {
    use crate::io::TerrainIO;
    use crate::ore::OreNodeIndex;
    use onlinerpg_shared::worldgen::ore_nodes::MAX_NODES_PER_TILE;
    use std::path::PathBuf;

    /// Where a bake writes tiles, relative to the workspace root.
    fn terrain_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("data/terrain")
    }

    /// Walk every baked tile in a region block and report the vein
    /// distribution a player would actually meet.
    #[tokio::test]
    #[ignore = "requires a baked data/terrain (see module docs)"]
    async fn ore_density_over_baked_terrain() {
        let dir = terrain_dir();
        assert!(
            dir.join("height").is_dir(),
            "no baked terrain at {dir:?} — run terrain-gen bake first"
        );
        let baked = crate::io::baked_tiles(&dir);
        assert!(
            !baked.is_empty(),
            "no baked height tiles under {dir:?} — run terrain-gen bake first"
        );
        let index = OreNodeIndex::new(TerrainIO::new(dir));

        let mut tiles_scanned = 0u32;
        let mut tiles_with_ore = 0u32;
        let mut total_veins = 0u32;
        let mut total_yield = 0u32;
        let mut at_cap = 0u32;
        let mut altitudes: Vec<f32> = Vec::new();

        for (tx, tz) in baked {
            let nodes = index.nodes_for_tile(tx, tz).await.expect("tile read");
            tiles_scanned += 1;
            if nodes.is_empty() {
                continue;
            }
            tiles_with_ore += 1;
            total_veins += nodes.len() as u32;
            if nodes.len() == MAX_NODES_PER_TILE {
                at_cap += 1;
            }
            for n in nodes.iter() {
                total_yield += u32::from(n.yield_total);
                altitudes.push(n.world_y);
            }
        }

        altitudes.sort_by(f32::total_cmp);
        let median = altitudes
            .get(altitudes.len() / 2)
            .copied()
            .unwrap_or_default();
        let pct_tiles = 100.0 * f64::from(tiles_with_ore) / f64::from(tiles_scanned);
        // One tile is 64×64 m, so veins per km² = veins per tile × 244.
        let veins_per_km2 = f64::from(total_veins) / f64::from(tiles_scanned) * 244.0;

        println!("--- ore density over baked terrain ---");
        println!("tiles scanned          : {tiles_scanned}");
        println!("tiles with ore         : {tiles_with_ore} ({pct_tiles:.1}%)");
        println!("veins total            : {total_veins}");
        println!(
            "veins per ore tile     : {:.2}",
            f64::from(total_veins) / f64::from(tiles_with_ore.max(1))
        );
        println!("tiles at the {MAX_NODES_PER_TILE}-vein cap: {at_cap}");
        println!("veins per km²          : {veins_per_km2:.1}");
        println!(
            "ore per vein (avg)     : {:.2}",
            f64::from(total_yield) / f64::from(total_veins.max(1))
        );
        println!(
            "vein altitude m        : min {:.1} / median {:.1} / max {:.1}",
            altitudes.first().copied().unwrap_or_default(),
            median,
            altitudes.last().copied().unwrap_or_default()
        );

        // The shape mining is tuned for: ore is a reason to go to the
        // mountains, not something underfoot in every meadow, and not so
        // rare that prospecting is hopeless.
        assert!(total_veins > 0, "a baked world must contain some ore");
        assert!(
            pct_tiles < 50.0,
            "ore on {pct_tiles:.1}% of tiles — too common to be worth travelling for"
        );
        assert!(
            altitudes.first().copied().unwrap_or_default() >= 0.5,
            "veins must never sit below the waterline"
        );
    }
}
