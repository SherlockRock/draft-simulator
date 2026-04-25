use crate::draft_state::{DraftState, Phase, Side};
use crate::pools::{pool_multiplier, Penalties, Role, TeamPool};
use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub struct PhaseWeights {
    pub info: f64,
    pub comp: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct PhaseWeightTable {
    pub ban1: PhaseWeights,
    pub pick1: PhaseWeights,
    pub ban2: PhaseWeights,
    pub pick2: PhaseWeights,
}

pub fn phase_weight_for(
    side: Side,
    phase: Phase,
    blue: &PhaseWeightTable,
    red: &PhaseWeightTable,
) -> PhaseWeights {
    let table = match side {
        Side::Blue => blue,
        Side::Red => red,
    };
    match phase {
        Phase::Ban1 => table.ban1,
        Phase::Pick1 => table.pick1,
        Phase::Ban2 => table.ban2,
        Phase::Pick2 => table.pick2,
    }
}

pub struct EvalContext {
    pub side: Side,
    pub phase: Phase,
    pub our_pool: TeamPool,
    pub opp_pool: TeamPool,
    pub penalties: Penalties,
    pub champion_meta: HashMap<String, ChampionMeta>,
    pub phase_weights_blue: PhaseWeightTable,
    pub phase_weights_red: PhaseWeightTable,
    pub synergy_multiplier: f64,
    pub counter_multiplier: f64,
    pub flex_retention_weight: f64,
    pub reveal_cost_weight: f64,
}

#[allow(non_snake_case)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ScoreSet {
    pub composite: f64,
    pub compStrength: f64,
    pub informationValue: f64,
    pub flexRetention: f64,
    pub revealCost: f64,
}

/// Score a single champion at a specific role, given the current draft state.
/// Components: comp strength (in-progress), information value, then composite blend
/// weighted by side+phase. Pool-tier penalty multiplies the final composite.
pub fn score_pick(
    champion_id: &str,
    role: Role,
    _state: &DraftState,
    ctx: &EvalContext,
) -> ScoreSet {
    let comp_strength = comp_strength_for(champion_id, role, ctx);
    let information_value = information_value_for(champion_id, role, ctx);
    let flex_retention = flex_retention_for(champion_id, ctx);
    let reveal_cost = reveal_cost_for(champion_id, role, ctx);

    let weights = phase_weight_for(
        ctx.side,
        ctx.phase,
        &ctx.phase_weights_blue,
        &ctx.phase_weights_red,
    );
    let raw_composite = weights.comp * comp_strength + weights.info * information_value;

    let (multiplier, _tier) = pool_multiplier(champion_id, role, &ctx.our_pool, &ctx.penalties);

    ScoreSet {
        composite: raw_composite * multiplier,
        compStrength: comp_strength,
        informationValue: information_value,
        flexRetention: flex_retention,
        revealCost: reveal_cost,
    }
}

fn comp_strength_for(_champion_id: &str, _role: Role, _ctx: &EvalContext) -> f64 {
    // Task 4.2 wires real synergy/counter math; placeholder seed for the frame.
    0.5
}

fn information_value_for(_champion_id: &str, _role: Role, ctx: &EvalContext) -> f64 {
    // Task 4.3 wires real flex retention + reveal cost.
    0.5 * ctx.flex_retention_weight + 0.0 * ctx.reveal_cost_weight
}

fn flex_retention_for(_champion_id: &str, _ctx: &EvalContext) -> f64 {
    0.5
}

fn reveal_cost_for(_champion_id: &str, _role: Role, _ctx: &EvalContext) -> f64 {
    0.0
}
