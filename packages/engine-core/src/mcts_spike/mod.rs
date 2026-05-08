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

pub mod eval_ctx;
pub mod feasibility_cache;
pub mod pareto;
pub mod policy;
pub mod prior;
pub mod procedural_fixture;
pub mod real_data_fixture;
pub mod rng;
pub mod rollout;
pub mod trajectory;
pub mod tree;

use crate::draft_state::{DraftState, Side};
use crate::pools::{Role, RolePoolMap, TeamPool};
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

/// Per-side champion pools (analog of production's blue/red TeamPool). Spike-
/// only — production uses `EvalContext.our_pool`/`opp_pool` after perspective
/// swap. The PoolContext is the root-side-anchored pair from which
/// `eval_ctx::build_spike_eval_ctx` builds the EvalContext.
///
/// v5 phase 1 — both engines must scope candidate enumeration to the picking
/// side's `pool.search`. `PoolContext::full(fixture)` reproduces v1-v4
/// behavior (both sides see every champion) for backward compatibility with
/// existing smoke tests and the procedural fixture comparisons.
#[derive(Clone, Debug)]
pub struct PoolContext {
    pub blue: TeamPool,
    pub red: TeamPool,
}

impl PoolContext {
    /// Both sides see every champion in the fixture. Preserves v1-v4
    /// candidate enumeration behavior.
    pub fn full(fixture: &SpikeFixture) -> Self {
        let pool = make_full_team_pool(fixture);
        Self { blue: pool.clone(), red: pool }
    }

    /// Side-asymmetric construction: blue and red can carry different pools.
    pub fn new(blue: TeamPool, red: TeamPool) -> Self {
        Self { blue, red }
    }

    pub fn for_side(&self, side: Side) -> &TeamPool {
        match side {
            Side::Blue => &self.blue,
            Side::Red => &self.red,
        }
    }
}

/// Build a TeamPool covering every champion in the fixture: each champ
/// appears under each of their listed playable roles in `display`, and all
/// champs land in `search`. This is the "full pool" baseline.
pub fn make_full_team_pool(fixture: &SpikeFixture) -> TeamPool {
    let mut top = Vec::new();
    let mut jg = Vec::new();
    let mut mid = Vec::new();
    let mut adc = Vec::new();
    let mut sup = Vec::new();
    for (id, m) in &fixture.meta {
        for r in &m.positions {
            match r {
                Role::Top => top.push(id.clone()),
                Role::Jungle => jg.push(id.clone()),
                Role::Middle => mid.push(id.clone()),
                Role::Adc => adc.push(id.clone()),
                Role::Support => sup.push(id.clone()),
            }
        }
    }
    TeamPool {
        display: RolePoolMap { top, jungle: jg, middle: mid, adc, support: sup },
        search: fixture.all_champions.clone(),
    }
}

/// Terminal eval over the 3 spike axes. All axes are `blue - red`.
///
/// - `winrate`: sum of per-pick winrates (0.5 default for unknown). Same as v1.
/// - `coverage`: `coverage::coverage_score` (geometric mean of per-role max
///   position factors) per side. Picks are 5-long at terminal.
/// - `flex`: count of side's picks with ≥2 playable roles. Range -5..5.
pub fn terminal_eval(state: &DraftState, fixture: &SpikeFixture) -> ValueVector {
    let blue_wr: f64 = state
        .blue_picks
        .iter()
        .map(|c| fixture.winrates.get(c).copied().unwrap_or(0.5))
        .sum();
    let red_wr: f64 = state
        .red_picks
        .iter()
        .map(|c| fixture.winrates.get(c).copied().unwrap_or(0.5))
        .sum();
    let blue_cov = crate::coverage::coverage_score(&state.blue_picks, &fixture.meta);
    let red_cov = crate::coverage::coverage_score(&state.red_picks, &fixture.meta);
    let blue_flex = flex_count(&state.blue_picks, &fixture.meta) as f64;
    let red_flex = flex_count(&state.red_picks, &fixture.meta) as f64;
    ValueVector {
        winrate: blue_wr - red_wr,
        coverage: blue_cov - red_cov,
        flex: blue_flex - red_flex,
    }
}

/// Spike flex proxy: count of picks with ≥2 listed playable roles.
fn flex_count(picks: &[String], meta: &std::collections::HashMap<String, ChampionMeta>) -> usize {
    picks
        .iter()
        .filter_map(|c| meta.get(c))
        .filter(|m| m.positions.len() >= 2)
        .count()
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

/// 3 truly-independent backup axes. Sign convention: every dimension is
/// `blue - red` so existing UCT side-flipping logic in `policy.rs` carries
/// over unchanged by negating the whole vector for red-to-move.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ValueVector {
    pub winrate: f64,
    pub coverage: f64,
    pub flex: f64,
}

impl ValueVector {
    pub fn zero() -> Self {
        Self::default()
    }

    pub fn add_assign(&mut self, other: ValueVector) {
        self.winrate += other.winrate;
        self.coverage += other.coverage;
        self.flex += other.flex;
    }

    pub fn neg(self) -> Self {
        Self {
            winrate: -self.winrate,
            coverage: -self.coverage,
            flex: -self.flex,
        }
    }

    pub fn mean(self, visits: u32) -> Self {
        let n = visits.max(1) as f64;
        Self {
            winrate: self.winrate / n,
            coverage: self.coverage / n,
            flex: self.flex / n,
        }
    }

    /// Equal-weight composite. UCT mean+exploration uses this scalar so
    /// existing selection semantics survive vector backup.
    pub fn composite(&self) -> f64 {
        self.winrate + self.coverage + self.flex
    }

    /// Pareto dominance (strict): self ≥ other on every axis and > on at least one.
    pub fn dominates(&self, other: &Self) -> bool {
        let all_ge = self.winrate >= other.winrate
            && self.coverage >= other.coverage
            && self.flex >= other.flex;
        let any_gt = self.winrate > other.winrate
            || self.coverage > other.coverage
            || self.flex > other.flex;
        all_ge && any_gt
    }
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
