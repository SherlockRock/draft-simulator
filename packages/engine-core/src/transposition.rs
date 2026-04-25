use crate::draft_state::DraftState;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct StateHash(u64);

impl StateHash {
    pub fn from(state: &DraftState) -> Self {
        // Bans hashed as multisets (sorted)
        let mut blue_bans = state.blue_bans.clone();
        blue_bans.sort();
        let mut red_bans = state.red_bans.clone();
        red_bans.sort();

        // Picks: canonicalize each pair-pick revelation group so that the two
        // members of a pair are order-invariant inside the hash.
        let blue_picks_canon = canonicalize_blue_picks(&state.blue_picks);
        let red_picks_canon = canonicalize_red_picks(&state.red_picks);

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        blue_bans.hash(&mut hasher);
        red_bans.hash(&mut hasher);
        blue_picks_canon.hash(&mut hasher);
        red_picks_canon.hash(&mut hasher);
        StateHash(hasher.finish())
    }
}

fn canonicalize_blue_picks(picks: &[String]) -> Vec<String> {
    // Blue pick order in DraftState.blue_picks:
    //   index 0 = B1 (slot 6)
    //   index 1 = B2 (slot 9), index 2 = B3 (slot 10) — paired
    //   index 3 = B4 (slot 17), index 4 = B5 (slot 18) — paired
    let mut out: Vec<String> = picks.to_vec();
    if out.len() >= 3 {
        out[1..3].sort();
    }
    if out.len() >= 5 {
        out[3..5].sort();
    }
    out
}

fn canonicalize_red_picks(picks: &[String]) -> Vec<String> {
    // Red pick order in DraftState.red_picks:
    //   index 0 = R1 (slot 7), index 1 = R2 (slot 8) — paired
    //   index 2 = R3 (slot 11)
    //   index 3 = R4 (slot 16)
    //   index 4 = R5 (slot 19)
    let mut out: Vec<String> = picks.to_vec();
    if out.len() >= 2 {
        out[0..2].sort();
    }
    out
}

#[derive(Default)]
pub struct TranspositionCache {
    map: HashMap<StateHash, f64>,
}

impl TranspositionCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, hash: StateHash, score: f64) {
        self.map.insert(hash, score);
    }

    pub fn get(&self, hash: &StateHash) -> Option<f64> {
        self.map.get(hash).copied()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
