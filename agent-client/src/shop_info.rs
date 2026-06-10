//! Shop knowledge injected into merchant NPC system prompts. The server is
//! the authority on prices and haggling limits (`server/src/game_state/`);
//! this is the same data given to the LLM purely for roleplay, per
//! `doc/ECONOMY.md`. Game data is embedded at compile time like the server
//! does, so the agent-client needs no runtime path to `data/`.

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Deserialize)]
struct MerchantRow {
    #[serde(rename = "npcName")]
    npc_name: String,
    #[serde(rename = "sellRatePercent")]
    sell_rate_percent: u32,
    catalog: String,
}

#[derive(Deserialize)]
struct ItemRow {
    name: String,
    #[serde(rename = "basePrice")]
    base_price: Option<i64>,
}

/// Format an amount in the smallest unit as gold/silver/copper
/// (1g = 100s = 10,000c), matching the human client's display.
fn format_price(copper: i64) -> String {
    let g = copper / 10_000;
    let s = (copper % 10_000) / 100;
    let c = copper % 100;
    let mut parts = Vec::new();
    if g > 0 {
        parts.push(format!("{g}g"));
    }
    if s > 0 {
        parts.push(format!("{s}s"));
    }
    if c > 0 || parts.is_empty() {
        parts.push(format!("{c}c"));
    }
    parts.join(" ")
}

/// Build the "Your Shop" system-prompt section for an NPC, or `None` if the
/// character is not a merchant.
pub fn shop_prompt_for(npc_name: &str) -> Option<String> {
    let merchants: HashMap<String, MerchantRow> =
        serde_json::from_str(include_str!("../../data/merchants.json")).ok()?;
    let items: HashMap<String, ItemRow> =
        serde_json::from_str(include_str!("../../data/items.json")).ok()?;
    let merchant = merchants
        .values()
        .find(|m| m.npc_name.eq_ignore_ascii_case(npc_name))?;

    let mut section = String::from("## Your Shop\nItems you sell, with base prices:\n");
    for item_id in merchant.catalog.split(';').map(str::trim) {
        let Some(item) = items.get(item_id) else {
            continue;
        };
        let price = item.base_price.map_or("?".to_string(), format_price);
        section.push_str(&format!("- {item_id} ({}): {price}\n", item.name));
    }
    section.push_str(&format!(
        "You also buy any item that has a base price from players, paying {}% of its base price.\n",
        merchant.sell_rate_percent
    ));
    Some(section)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_mixed_denominations() {
        assert_eq!(format_price(0), "0c");
        assert_eq!(format_price(50), "50c");
        assert_eq!(format_price(2_500), "25s");
        assert_eq!(format_price(10_000), "1g");
        assert_eq!(format_price(12_345), "1g 23s 45c");
    }

    #[test]
    fn rica_has_a_shop_section() {
        let section = shop_prompt_for("Rica").expect("Rica is a merchant");
        assert!(section.contains("iron_sword"));
        assert!(section.contains("1g"));
        assert!(section.contains("40%"));
        assert!(shop_prompt_for("Karl").is_none());
    }
}
