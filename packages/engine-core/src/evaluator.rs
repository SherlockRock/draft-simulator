use crate::coverage::coverage_marginal_gain;
use crate::draft_state::{ActionType, DraftState, Phase, Side};
use crate::pools::{pool_multiplier, Penalties, Role, TeamPool};
use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub struct PhaseWeights {
    pub info: f64,
    pub comp: f64,
    pub coverage: f64,
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

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct SideValues {
    pub blue: f64,
    pub red: f64,
}

impl SideValues {
    pub fn for_side(&self, side: Side) -> f64 {
        match side {
            Side::Blue => self.blue,
            Side::Red => self.red,
        }
    }
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

impl EvalContext {
    /// Returns a clone with all per-perspective fields swapped to score from
    /// `target_side`'s perspective. Picks come from the projected `state`
    /// (NOT from the root snapshot's picks/opp_picks fields).
    pub fn for_perspective(&self, target_side: Side, state: &DraftState, phase: Phase) -> Self {
        let mut next = self.clone();
        next.side = target_side;
        next.phase = phase;
        match target_side {
            Side::Blue => {
                next.our_pool = self.pool_for(Side::Blue);
                next.opp_pool = self.pool_for(Side::Red);
                next.our_picks = state.blue_picks.clone();
                next.opp_picks = state.red_picks.clone();
            }
            Side::Red => {
                next.our_pool = self.pool_for(Side::Red);
                next.opp_pool = self.pool_for(Side::Blue);
                next.our_picks = state.red_picks.clone();
                next.opp_picks = state.blue_picks.clone();
            }
        }
        next
    }

    /// Returns the pool for `side` based on the CURRENT context's perspective.
    /// `our_pool` corresponds to `self.side`; `opp_pool` to the opposite.
    fn pool_for(&self, side: Side) -> TeamPool {
        if side == self.side { self.our_pool.clone() } else { self.opp_pool.clone() }
    }
}

#[allow(non_snake_case)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ScoreSet {
    pub composite: f64,                 // Backward compat with projection.rs:282, 332. Set to composite_per_side.for_side(eval_ctx.side).
    pub composite_per_side: SideValues, // The load-bearing value.
    pub compStrength: f64,
    pub informationValue: f64,
    pub flexRetention: f64,
    pub revealCost: f64,
    pub roleCoverage: f64,
}

/// Score a single champion at a specific role, given the current draft state.
/// Components: comp strength (in-progress), information value, role coverage,
/// then composite blend weighted by side+phase. Pool-tier penalty multiplies
/// the final composite.
pub fn score_pick(
    champion_id: &str,
    role: Role,
    state: &DraftState,
    ctx: &EvalContext,
    action_type: ActionType,
) -> ScoreSet {
    let comp_strength = comp_strength_for(champion_id, role, ctx);
    let information_value = information_value_for(champion_id, role, ctx);
    let flex_retention = flex_retention_for(champion_id, ctx);
    let reveal_cost = reveal_cost_for(champion_id, role, ctx);
    let role_coverage = role_coverage_for(champion_id, state, ctx, action_type);

    let weights = phase_weight_for(
        ctx.side,
        ctx.phase,
        &ctx.phase_weights_blue,
        &ctx.phase_weights_red,
    );
    let raw_composite = weights.comp * comp_strength
        + weights.info * information_value
        + weights.coverage * role_coverage;

    // NOTE: ban scoring still goes through pool_multiplier. Today
    // ban_multiplier returns 1.0 (a stub), but switching bans to it now
    // would silently change ban rankings. Leaving as a follow-up.
    let (multiplier, _tier) = pool_multiplier(champion_id, role, &ctx.our_pool, &ctx.penalties);

    ScoreSet {
        composite: raw_composite * multiplier,
        composite_per_side: SideValues {
            blue: if ctx.side == Side::Blue { raw_composite * multiplier } else { 0.0 },
            red:  if ctx.side == Side::Red  { raw_composite * multiplier } else { 0.0 },
        },
        compStrength: comp_strength,
        informationValue: information_value,
        flexRetention: flex_retention,
        revealCost: reveal_cost,
        roleCoverage: role_coverage,
    }
}

/// Marginal coverage gain from adding `candidate` to the appropriate
/// team's picks. Picks come from the recursive search state — NOT from
/// `ctx.our_picks` — because the search needs to evaluate at the
/// projected node state, not the root snapshot.
fn role_coverage_for(
    candidate: &str,
    state: &DraftState,
    ctx: &EvalContext,
    action_type: ActionType,
) -> f64 {
    let picks_to_use: &[String] = match (action_type, ctx.side) {
        // Pick: marginal gain on OUR team — fill our gap
        (ActionType::Pick, Side::Blue) => &state.blue_picks,
        (ActionType::Pick, Side::Red) => &state.red_picks,
        // Ban: marginal gain on OPPONENT — deny their gap
        (ActionType::Ban, Side::Blue) => &state.red_picks,
        (ActionType::Ban, Side::Red) => &state.blue_picks,
    };
    coverage_marginal_gain(picks_to_use, candidate, &ctx.champion_meta)
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
    // Phase 3 of the role-parity plan relaxes solve() to accept partial picks,
    // but flex_retention's semantic (info-value baseline at incomplete comp)
    // intentionally returns 1.0 until the comp is complete. Lifting this guard
    // would silently shift informationValue mid-draft and propagate into
    // composite scores throughout Phase 2's leaf evals.
    if ctx.our_picks.len() < 5 {
        return 1.0;
    }
    // role_solver::solve panics on unknown champion ids; guard at call site
    // so terminal-state evals over filler IDs (test fixtures) don't crash.
    if ctx
        .our_picks
        .iter()
        .any(|id| !ctx.champion_meta.contains_key(id.as_str()))
    {
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
