//! Declared turn sequences (design § 2, S2, S3). A fixture declares turns; the state and the
//! mid-pair-root rule work in slots. `Format` owns the mapping.

use crate::draft_state::{ActionType, Side};
use serde::Deserialize;

/// What a turn asks its side to do. A `Pair` is one decision unit that fills two slots (D8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Ban,
    Pick,
    Pair,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Turn {
    pub side: Side,
    pub kind: Kind,
}

/// One board slot. Mirrors the incumbent's `TurnInfo` shape without its `phase`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    pub side: Side,
    pub action: ActionType,
    pub pair_start: bool,
    pub pair_end: bool,
}

const fn t(side: Side, kind: Kind) -> Turn {
    Turn { side, kind }
}

/// The standard draft as seventeen turns. Declared here, not derived from
/// `draft_state::TURN_SEQUENCE` (S3); `tests/reference.rs` asserts the two agree slot by slot.
pub const STANDARD_TURNS: [Turn; 17] = [
    t(Side::Blue, Kind::Ban),
    t(Side::Red, Kind::Ban),
    t(Side::Blue, Kind::Ban),
    t(Side::Red, Kind::Ban),
    t(Side::Blue, Kind::Ban),
    t(Side::Red, Kind::Ban),
    t(Side::Blue, Kind::Pick),
    t(Side::Red, Kind::Pair),
    t(Side::Blue, Kind::Pair),
    t(Side::Red, Kind::Pick),
    t(Side::Red, Kind::Ban),
    t(Side::Blue, Kind::Ban),
    t(Side::Red, Kind::Ban),
    t(Side::Blue, Kind::Ban),
    t(Side::Red, Kind::Pick),
    t(Side::Blue, Kind::Pair),
    t(Side::Red, Kind::Pick),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Format {
    turns: Vec<Turn>,
    slots: Vec<Slot>,
}

impl Format {
    pub fn standard() -> Self {
        Self::explicit(STANDARD_TURNS.to_vec())
    }

    pub fn explicit(turns: Vec<Turn>) -> Self {
        let mut slots = Vec::with_capacity(turns.len() + 3);
        for turn in &turns {
            let slot = |action, pair_start, pair_end| Slot {
                side: turn.side,
                action,
                pair_start,
                pair_end,
            };
            match turn.kind {
                Kind::Ban => slots.push(slot(ActionType::Ban, false, false)),
                Kind::Pick => slots.push(slot(ActionType::Pick, false, false)),
                Kind::Pair => {
                    slots.push(slot(ActionType::Pick, true, false));
                    slots.push(slot(ActionType::Pick, false, true));
                }
            }
        }
        Self { turns, slots }
    }

    pub fn turns(&self) -> &[Turn] {
        &self.turns
    }

    pub fn slots(&self) -> &[Slot] {
        &self.slots
    }

    pub fn slot(&self, index: usize) -> Option<Slot> {
        self.slots.get(index).copied()
    }

    pub fn picks_per_side(&self, side: Side) -> usize {
        self.picks_remaining(side, 0)
    }

    /// Pick slots for `side` at or after `from_slot`.
    pub fn picks_remaining(&self, side: Side, from_slot: usize) -> usize {
        self.slots
            .iter()
            .skip(from_slot)
            .filter(|s| s.side == side && s.action == ActionType::Pick)
            .count()
    }

    /// Turns at or after `from_slot`. A pair counts once; a pair whose first half is already
    /// filled (`from_slot` is its second half) also counts once — the completing pick.
    pub fn turns_remaining(&self, from_slot: usize) -> usize {
        let mut turns = 0;
        let mut i = from_slot;
        while i < self.slots.len() {
            turns += 1;
            i += if self.slots[i].pair_start { 2 } else { 1 };
        }
        turns
    }
}
