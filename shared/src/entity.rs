//! Live in-game entity records: the per-frame state the server broadcasts
//! for every player and monster. `Player` and `Monster` are the snapshot
//! types embedded in `ServerMessage::GameState`; `MonsterState` is the
//! enum the client renders as an animation pose.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::character::{CharacterClass, Gender};
use crate::world::Position;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub position: Position,
    pub rotation: f32,
    pub level: u32,
    pub health: u32,
    pub max_health: u32,
    pub class: CharacterClass,
    #[serde(default)]
    pub gender: Gender,
    #[serde(default)]
    pub is_npc: bool,
    #[serde(default)]
    pub torch_on: bool,
    #[serde(default)]
    pub floor_level: i8,
    // NEVER add `skip_serializing_if` here: rmp_serde::to_vec encodes
    // structs as positional arrays, so skipping a mid-struct field shifts
    // every later field into the wrong slot on the wire.
    #[serde(default)]
    pub object_type: Option<String>,
    #[serde(skip)]
    pub object_id: Option<u32>,
    #[serde(skip)]
    pub last_combat_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MonsterState {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "walk")]
    Walk,
    #[serde(rename = "run")]
    Run,
    #[serde(rename = "attack")]
    Attack,
    #[serde(rename = "hit")]
    Hit,
    #[serde(rename = "dead")]
    Dead,
}

impl fmt::Display for MonsterState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Walk => write!(f, "walk"),
            Self::Run => write!(f, "run"),
            Self::Attack => write!(f, "attack"),
            Self::Hit => write!(f, "hit"),
            Self::Dead => write!(f, "dead"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Monster {
    pub id: String,
    pub monster_type: String,
    pub position: Position,
    pub rotation: f32,
    pub state: MonsterState,
    pub owner_id: Option<String>,
    pub health: u32,
    pub max_health: u32,
    /// 0 = overworld, 1..3 housing floors, negative = dungeon depth.
    #[serde(default)]
    pub floor_level: i8,
    /// Depth-scaled combat level for dungeon monsters; `None` uses the
    /// monster definition's level.
    // `skip_serializing_if` here dropped the field from rmp_serde's
    // positional array for every overworld monster, shifting `aggressive`
    // into this slot on the wire — the client then read the bool where it
    // expected this u8 and rejected the whole message.
    #[serde(default)]
    pub level_override: Option<u8>,
    /// Proactive (선공형) monster: attacks players on sight rather than only
    /// retaliating when hit. Drives behavior-tree selection on the agent-client.
    #[serde(default)]
    pub aggressive: bool,
    #[serde(skip)]
    pub last_attack_at: u64,
}

impl Monster {
    /// Gate for client-driven mutations (move/attack): alive and owned by the requester.
    pub fn is_controllable_by(&self, player_id: &str) -> bool {
        self.state != MonsterState::Dead && self.owner_id.as_deref() == Some(player_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rmp_serde encodes structs as positional arrays, so every field must
    /// serialize unconditionally — a `skip_serializing_if` that fires shifts
    /// all later fields into the wrong slots. These round-trip the exact
    /// case that broke: an overworld monster with `level_override: None`
    /// followed by a populated `aggressive` flag.
    #[test]
    fn monster_roundtrips_with_none_level_override() {
        let monster = Monster {
            id: "m1".into(),
            monster_type: "slime".into(),
            position: Position {
                x: 1.0,
                y: 2.0,
                z: 3.0,
            },
            rotation: 0.5,
            state: MonsterState::Walk,
            owner_id: None,
            health: 10,
            max_health: 12,
            floor_level: 0,
            level_override: None,
            aggressive: true,
            last_attack_at: 0,
        };
        let bytes = rmp_serde::to_vec(&monster).unwrap();
        let decoded: Monster = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.level_override, None);
        assert!(decoded.aggressive);
    }

    #[test]
    fn player_roundtrips_with_none_object_type() {
        let player = Player {
            id: "p1".into(),
            name: "jake".into(),
            position: Position {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            rotation: 0.0,
            level: 3,
            health: 17,
            max_health: 17,
            class: CharacterClass::Knight,
            gender: Gender::default(),
            is_npc: false,
            torch_on: true,
            floor_level: 0,
            object_type: None,
            object_id: None,
            last_combat_at: 0,
        };
        let bytes = rmp_serde::to_vec(&player).unwrap();
        let decoded: Player = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.object_type, None);
        assert!(decoded.torch_on);
    }
}
