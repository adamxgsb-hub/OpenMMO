use onlinerpg_shared::inventory::EquipSlot;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::info;

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ItemDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub weight: f32,
    #[serde(rename = "equipSlot")]
    pub equip_slot: Option<EquipSlot>,
    #[serde(default)]
    pub stackable: bool,
    #[serde(rename = "worldModel")]
    pub world_model: Option<String>,
    #[serde(rename = "damageDice")]
    pub damage_dice: Option<String>,
    #[serde(default)]
    pub material: Option<String>,
    /// Base price in the smallest currency unit. Items without a price
    /// cannot be bought or sold.
    #[serde(rename = "basePrice")]
    pub base_price: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ItemDefs {
    defs: Arc<HashMap<String, ItemDefinition>>,
}

impl ItemDefs {
    pub fn load() -> Self {
        let data = include_str!("../../data/items.json");
        let defs: HashMap<String, ItemDefinition> =
            serde_json::from_str(data).expect("Failed to parse items.json");

        info!("Loaded {} item definitions", defs.len());
        for (id, def) in &defs {
            info!(
                "  {} - weight:{} equipSlot:{:?} stackable:{}",
                id, def.weight, def.equip_slot, def.stackable
            );
        }

        Self {
            defs: Arc::new(defs),
        }
    }

    pub fn get(&self, item_def_id: &str) -> Option<&ItemDefinition> {
        self.defs.get(item_def_id)
    }

    pub fn item_def_id_for_weapon_ref(&self, weapon_ref: &str) -> Option<String> {
        if self.defs.contains_key(weapon_ref) {
            return Some(weapon_ref.to_string());
        }

        if let Some(item_id) = weapon_ref
            .strip_suffix(".glb")
            .filter(|item_id| self.defs.contains_key(*item_id))
        {
            return Some(item_id.to_string());
        }

        self.defs
            .values()
            .find(|def| def.world_model.as_deref() == Some(weapon_ref))
            .map(|def| def.id.clone())
    }

    pub fn damage_dice_for_weapon_model(&self, weapon_model: &str) -> Option<String> {
        self.item_def_id_for_weapon_ref(weapon_model)
            .and_then(|item_id| self.defs.get(&item_id))
            .and_then(|def| def.damage_dice.clone())
    }

    /// Equippable items at or above a price floor — the dungeon treasure
    /// chest loot pool. Sorted for determinism before the caller shuffles.
    pub fn equipment_ids_with_min_price(&self, min_price: i64) -> Vec<String> {
        let mut ids: Vec<String> = self
            .defs
            .values()
            .filter(|def| def.equip_slot.is_some())
            .filter(|def| def.base_price.is_some_and(|p| p >= min_price))
            .map(|def| def.id.clone())
            .collect();
        ids.sort();
        ids
    }

    pub fn weight(&self, item_def_id: &str) -> f32 {
        self.defs.get(item_def_id).map(|d| d.weight).unwrap_or(1.0)
    }
}
