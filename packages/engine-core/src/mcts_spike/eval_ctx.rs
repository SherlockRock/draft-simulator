//! Shared EvalContext builder for the spike. Used by:
//!   - `prior.rs` to call `score_pick` for shortlisting candidates.
//!   - `examples/ab_sanity.rs` to drive the production alpha-beta search.
//!
//! Both consumers MUST use this builder so the prior and AB are
//! scoring against identical objectives — that's the v3 alignment fix.

use crate::draft_state::{DraftState, Phase, Side};
use crate::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use crate::pools::{Penalties, Role, RolePoolMap, TeamPool};
use std::collections::HashMap;

use super::SpikeFixture;

/// Neutral phase weights — comp=1, coverage=1, info=0. Matches what
/// `ab_sanity.rs` v2 used. Keeps the spike's prior + AB wrapper aligned.
fn neutral_phase_weights() -> PhaseWeightTable {
    let w = PhaseWeights { info: 0.0, comp: 1.0, coverage: 1.0 };
    PhaseWeightTable { ban1: w, pick1: w, ban2: w, pick2: w }
}

/// Build a TeamPool from the spike fixture: every champ shows up under
/// every role they're listed for. `search` field is the flat candidate
/// list. Identical for both sides because the spike's pools aren't
/// asymmetric.
fn make_pool(fixture: &SpikeFixture) -> TeamPool {
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

/// Build a production EvalContext from the spike fixture for `our_side`'s
/// perspective at `state`. Phase comes from the current turn (Pick2 default
/// at terminal). Pools, meta, weights all come from `fixture`.
pub fn build_spike_eval_ctx(
    fixture: &SpikeFixture,
    state: &DraftState,
    our_side: Side,
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
    EvalContext {
        side: our_side,
        phase,
        our_pool: make_pool(fixture),
        opp_pool: make_pool(fixture),
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
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    }
}
