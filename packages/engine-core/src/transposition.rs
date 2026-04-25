use crate::draft_state::DraftState;
use std::cell::Cell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct StateHash(u64);

impl StateHash {
    pub fn from_u64(value: u64) -> Self {
        Self(value)
    }

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
    let mut out: Vec<String> = picks.to_vec();
    if out.len() >= 2 {
        out[0..2].sort();
    }
    out
}

/// Per-compute transposition cache. Generic over the cached value so callers
/// can store either a propagated score (f64) or a full TreeNode. Single-threaded
/// by design — interior mutability via Cell tracks hit counts without requiring
/// `&mut` at every read site.
pub struct TranspositionCache<V = f64> {
    map: HashMap<StateHash, V>,
    hits: Cell<usize>,
}

impl<V: Clone> Default for TranspositionCache<V> {
    fn default() -> Self {
        Self {
            map: HashMap::new(),
            hits: Cell::new(0),
        }
    }
}

impl<V: Clone> TranspositionCache<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, hash: StateHash, value: V) {
        self.map.insert(hash, value);
    }

    pub fn get(&self, hash: &StateHash) -> Option<V> {
        let result = self.map.get(hash).cloned();
        if result.is_some() {
            self.hits.set(self.hits.get() + 1);
        }
        result
    }

    pub fn hits(&self) -> usize {
        self.hits.get()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
