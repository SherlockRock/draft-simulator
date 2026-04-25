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

#[derive(Clone, Debug)]
pub struct SynergyRule {
    pub tags: (String, String),
    pub bonus: f64,
}

#[derive(Clone, Debug, Default)]
pub struct MetaData {
    pub win_rates: HashMap<String, f64>,
    pub synergies: Vec<SynergyRule>,
    pub counters: HashMap<String, HashMap<String, f64>>,
}

#[derive(Clone)]
pub struct EvalContext {
    pub side: Side,
    pub phase: Phase,
    pub our_pool: TeamPool,
    pub opp_pool: TeamPool,
    pub our_picks: Vec<String>,
    pub opp_picks: Vec<String>,
    pub penalties: Penalties,
    pub champion_meta: HashMap<String, ChampionMeta>,
    pub meta: MetaData,
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

fn comp_strength_for(champion_id: &str, _role: Role, ctx: &EvalContext) -> f64 {
    let win_rate = ctx.meta.win_rates.get(champion_id).copied().unwrap_or(0.5);
    let synergy = synergy_score(champion_id, &ctx.our_picks, &ctx.meta);
    let counter_risk = counter_risk(champion_id, &ctx.opp_picks, &ctx.meta);
    let raw = win_rate
        + ctx.synergy_multiplier * synergy
        - ctx.counter_multiplier * counter_risk;
    raw.clamp(0.0, 1.0)
}

fn synergy_score(champion_id: &str, teammates: &[String], meta: &MetaData) -> f64 {
    let candidate_tags = champion_tags(champion_id, &meta.synergies);
    let mut total = 0.0;
    for teammate in teammates {
        let mate_tags = champion_tags(teammate, &meta.synergies);
        for (a, b) in candidate_tags.iter().zip(mate_tags.iter()) {
            for rule in &meta.synergies {
                if (rule.tags.0 == *a && rule.tags.1 == *b)
                    || (rule.tags.0 == *b && rule.tags.1 == *a)
                {
                    total += rule.bonus;
                }
            }
        }
    }
    total
}

fn champion_tags<'a>(_champion_id: &str, _synergies: &'a [SynergyRule]) -> Vec<String> {
    // Stub. Tag-based synergy keys come from championMeta which lands at
    // engine boot (Task 7.x). Returning empty keeps synergy contribution at 0
    // until that wiring exists, which is fine for the tests in this phase.
    Vec::new()
}

fn counter_risk(champion_id: &str, opponents: &[String], meta: &MetaData) -> f64 {
    let mut total = 0.0;
    if let Some(counter_map) = meta.counters.get(champion_id) {
        for opp in opponents {
            if let Some(diff) = counter_map.get(opp) {
                // negative differential means we get countered by `opp`
                total += (-diff).max(0.0);
            }
        }
    }
    total
}

fn information_value_for(_champion_id: &str, _role: Role, ctx: &EvalContext) -> f64 {
    let flex = flex_retention_for("", ctx);
    let reveal = reveal_cost_for("", Role::Top, ctx);
    ctx.flex_retention_weight * flex - ctx.reveal_cost_weight * reveal
}

fn flex_retention_for(_champion_id: &str, ctx: &EvalContext) -> f64 {
    use crate::role_solver::solve;
    if ctx.our_picks.len() < 5 {
        // Pre-resolved partial comp — flex is high by construction.
        return 1.0;
    }
    let ids: Vec<&str> = ctx.our_picks.iter().map(|s| s.as_str()).collect();
    let assignments = solve(&ids, &ctx.champion_meta);
    let n = assignments.len() as f64;
    if n <= 1.0 {
        return 0.0;
    }
    let max_entropy = n.ln();
    let entropy: f64 = assignments
        .iter()
        .map(|a| if a.weight > 0.0 { -a.weight * a.weight.ln() } else { 0.0 })
        .sum();
    (entropy / max_entropy).clamp(0.0, 1.0)
}

fn reveal_cost_for(_champion_id: &str, _role: Role, ctx: &EvalContext) -> f64 {
    1.0 - flex_retention_for("", ctx)
}
