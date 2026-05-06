//! MCTS spike — exploratory measurement code, NOT production.
//!
//! Question this spike answers:
//!   1. Throughput — iterations/sec on representative positions.
//!   2. Convergence — does the visit distribution stabilize at our budgets?
//!   3. Sanity — do top moves agree with alpha-beta on the same positions?
//!
//! Intentional non-goals: WASM, multi-objective backup, streaming UI,
//! pair-pick handling, forced branches, transpositions, cancellation,
//! production code style. `unwrap()` is fine. Throw away after measurement.

pub mod feasibility_cache;
pub mod policy;
pub mod rng;
pub mod rollout;
pub mod tree;

use crate::draft_state::{DraftState, Side};
use crate::pools::Role;
use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

/// Champion → playable roles (computed once from ChampionMeta).
/// The spike's terminal eval is just sum-of-winrates per side.
#[derive(Clone, Debug)]
pub struct SpikeFixture {
    pub meta: HashMap<String, ChampionMeta>,
    pub winrates: HashMap<String, f64>,
    pub all_champions: Vec<String>,
}

/// Sum of winrates over picks. Returns blue minus red so positive favors blue.
/// Side-perspective scaling happens in backprop.
pub fn terminal_score(state: &DraftState, fixture: &SpikeFixture) -> f64 {
    let blue: f64 = state
        .blue_picks
        .iter()
        .map(|c| fixture.winrates.get(c).copied().unwrap_or(0.5))
        .sum();
    let red: f64 = state
        .red_picks
        .iter()
        .map(|c| fixture.winrates.get(c).copied().unwrap_or(0.5))
        .sum();
    blue - red
}

/// Whether the to-move side at this state is blue.
pub fn side_to_move(state: &DraftState) -> Option<Side> {
    state.current_turn().map(|t| t.side)
}

/// Pool of champions still selectable from this state (not banned, not picked).
pub fn pool_from_state(state: &DraftState, fixture: &SpikeFixture) -> Vec<String> {
    fixture
        .all_champions
        .iter()
        .filter(|c| !crate::draft_state::is_taken(c, state))
        .cloned()
        .collect()
}

/// Approximate playable-roles bitmask (used by feasibility_cache; production
/// feasibility.rs uses the same threshold of 0.4 against position_factor).
pub fn role_mask_for(champion: &str, meta: &HashMap<String, ChampionMeta>) -> u8 {
    use crate::role_solver::position_factor;
    let Some(m) = meta.get(champion) else {
        return 0;
    };
    let roles = [
        Role::Top,
        Role::Jungle,
        Role::Middle,
        Role::Adc,
        Role::Support,
    ];
    let mut mask: u8 = 0;
    for (idx, role) in roles.iter().enumerate() {
        if position_factor(*role, &m.positions) >= 0.4 {
            mask |= 1 << idx;
        }
    }
    mask
}
