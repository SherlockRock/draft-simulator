//! Shared EvalContext builder for the spike. Used by:
//!   - `prior.rs` to call `score_pick` for shortlisting candidates.
//!   - `examples/ab_sanity.rs` to drive the production alpha-beta search.
//!
//! Both consumers MUST use this builder so the prior and AB are
//! scoring against identical objectives — that's the v3 alignment fix.
//!
//! v5 phase 1: `build_spike_eval_ctx` now sources per-side pools from
//! `PoolContext` instead of constructing a full pool from the fixture. The
//! `for_full_pool` helper preserves v1-v4 behavior for callers (smoke tests,
//! procedural fixture runs) that don't care about pool support.

use crate::draft_state::{DraftState, Phase, Side};
use crate::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use crate::pools::Penalties;
use std::collections::HashMap;

use super::{PoolContext, SpikeFixture};

/// Neutral phase weights — comp=1, coverage=1, info=0. Matches what
/// `ab_sanity.rs` v2 used. Keeps the spike's prior + AB wrapper aligned.
fn neutral_phase_weights() -> PhaseWeightTable {
    let w = PhaseWeights { info: 0.0, comp: 1.0, coverage: 1.0 };
    PhaseWeightTable { ban1: w, pick1: w, ban2: w, pick2: w }
}

/// Build a production EvalContext from the spike fixture for `our_side`'s
/// perspective at `state`. Phase comes from the current turn (Pick2 default
/// at terminal). Pools come from the supplied `PoolContext` (so the picking
/// side's `our_pool.search` correctly scopes candidate enumeration); meta and
/// weights come from the fixture.
pub fn build_spike_eval_ctx(
    fixture: &SpikeFixture,
    state: &DraftState,
    our_side: Side,
    pools: &PoolContext,
) -> EvalContext {
    let phase = state
        .current_turn()
        .map(|t| t.phase)
        .unwrap_or(Phase::Pick2);
    let (our_picks, opp_picks) = if our_side == Side::Blue {
        (state.blue_picks.clone(), state.red_picks.clone())
    } else {
        (state.red_picks.clone(), state.blue_picks.clone())
    };
    let our_pool = pools.for_side(our_side).clone();
    let opp_pool = pools.for_side(our_side.opposite()).clone();
    EvalContext {
        side: our_side,
        phase,
        our_pool,
        opp_pool,
        our_picks,
        opp_picks,
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: fixture.meta.clone(),
        meta: MetaData {
            win_rates: fixture.winrates.clone(),
            synergies: Vec::new(),
            counters: HashMap::new(),
        },
        phase_weights_blue: neutral_phase_weights(),
        phase_weights_red: neutral_phase_weights(),
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        // Phase 6 (Option C): align spike's αβ-derived prior with the new
        // value formulation by honoring flex_retention. Mid-draft this is
        // the 1.0 baseline (no-op for ranking among candidates), but
        // late-rollout terminal score_pick calls now incorporate flex —
        // matching `terminal_eval`'s own flex axis.
        flex_retention_weight: 1.0,
        reveal_cost_weight: 0.0,
    }
}

/// Convenience for callers that don't care about pool scoping (existing
/// smoke tests, procedural fixture comparisons). Builds with
/// `PoolContext::full(fixture)`. v1-v4 behavior.
pub fn build_spike_eval_ctx_full_pool(
    fixture: &SpikeFixture,
    state: &DraftState,
    our_side: Side,
) -> EvalContext {
    let pools = PoolContext::full(fixture);
    build_spike_eval_ctx(fixture, state, our_side, &pools)
}
