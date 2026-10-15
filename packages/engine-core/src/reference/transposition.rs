//! Exact-only transposition table (design docs/designs/engine-reference-search-design.md R5). An entry is
//! stored only when the search knows the node's value is exact — the returned value lies strictly inside
//! the window the node was entered with (a full window included, since every value is finite) — so a hit
//! is always exact and needs no window check.
//!
//! Scope: one `search` call. The key carries no identity for the universe, the format, the pools, the
//! objective or the feasibility rule — all fixed for a search — so a table must never be shared across a
//! different one of any of them (the same rule as `FeasibilityMemo`).

use super::state::{Action, Position};
use super::universe::ChampionSet;
use crate::draft_state::Side;
use std::collections::HashMap;

/// Everything a subtree's value depends on within one search: the slot fixes the mover and the remaining
/// sequence; the three sets fix the board, the pools ∩ available and the picks-remaining count;
/// `turns_left` fixes the horizon. Ban ownership is absent on purpose (bans have no term).
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct Key {
    slot: usize,
    blue: ChampionSet,
    red: ChampionSet,
    taken: ChampionSet,
    turns_left: usize,
}

impl Key {
    pub fn of(position: &Position<'_>, turns_left: usize) -> Self {
        let set = |side: Side| -> ChampionSet { position.picks(side).iter().copied().collect() };
        Self {
            slot: position.slot_index(),
            blue: set(Side::Blue),
            red: set(Side::Red),
            taken: position.taken(),
            turns_left,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub value: f64,
    /// The node's principal continuation, mover-best at every step (R8).
    pub continuation: Vec<Action>,
}

#[derive(Debug, Default)]
pub struct TranspositionTable {
    map: HashMap<Key, Entry>,
    hits: u64,
}

impl TranspositionTable {
    /// Counts a hit.
    pub fn get(&mut self, key: &Key) -> Option<&Entry> {
        let entry = self.map.get(key);
        if entry.is_some() {
            self.hits += 1;
        }
        entry
    }

    /// Stores `entry` iff its value is exact for the window `(alpha0, beta0)` the node was entered with:
    /// `alpha0 < value < beta0`. A value equal to either bound is a fail-soft bound, not a value. Returns
    /// whether it stored.
    pub fn store_if_exact(&mut self, key: Key, entry: Entry, alpha0: f64, beta0: f64) -> bool {
        if alpha0 < entry.value && entry.value < beta0 {
            self.map.insert(key, entry);
            true
        } else {
            false
        }
    }

    pub fn hits(&self) -> u64 {
        self.hits
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
