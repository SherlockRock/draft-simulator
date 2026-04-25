use engine_core::draft_state::{DraftState, Phase, Side};
use engine_core::evaluator::{
    phase_weight_for, score_pick, EvalContext, PhaseWeightTable, PhaseWeights,
};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;

fn default_blue_weights() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.65, comp: 0.35 },
        pick1: PhaseWeights { info: 0.5, comp: 0.5 },
        ban2: PhaseWeights { info: 0.4, comp: 0.6 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8 },
    }
}

fn default_red_weights() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.7, comp: 0.3 },
        pick1: PhaseWeights { info: 0.6, comp: 0.4 },
        ban2: PhaseWeights { info: 0.5, comp: 0.5 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8 },
    }
}

fn ctx() -> EvalContext {
    let pool = TeamPool {
        display: RolePoolMap {
            top: vec!["Aatrox".into()],
            jungle: vec!["Vi".into()],
            middle: vec!["Ahri".into()],
            adc: vec!["Jinx".into()],
            support: vec!["Nautilus".into()],
        },
        search: vec![
            "Aatrox".into(),
            "Vi".into(),
            "Ahri".into(),
            "Jinx".into(),
            "Nautilus".into(),
            "Yone".into(),
        ],
    };
    let penalties = Penalties { out_of_role: 0.25, out_of_pool: 0.75 };

    let mut champion_meta = HashMap::new();
    champion_meta.insert(
        "Aatrox".into(),
        ChampionMeta { id: "Aatrox".into(), positions: vec![Role::Top] },
    );
    champion_meta.insert(
        "Yone".into(),
        ChampionMeta { id: "Yone".into(), positions: vec![Role::Middle, Role::Top] },
    );

    EvalContext {
        side: Side::Blue,
        phase: Phase::Pick1,
        our_pool: pool.clone(),
        opp_pool: pool,
        penalties,
        champion_meta,
        phase_weights_blue: default_blue_weights(),
        phase_weights_red: default_red_weights(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    }
}

#[test]
fn score_uses_role_in_evaluator() {
    let c = ctx();
    let state = DraftState::default();
    // Aatrox in TOP role → full multiplier (1.0)
    let aatrox_top = score_pick("Aatrox", Role::Top, &state, &c);
    // Aatrox in JUNGLE role → out-of-role penalty (× 0.75)
    let aatrox_jng = score_pick("Aatrox", Role::Jungle, &state, &c);
    assert!(
        aatrox_top.composite > aatrox_jng.composite,
        "in-role must score higher than out-of-role: top={} jng={}",
        aatrox_top.composite,
        aatrox_jng.composite
    );
}

#[test]
fn composite_uses_phase_weights() {
    let mut c = ctx();
    let state = DraftState::default();
    // Pick1: info=0.5 comp=0.5
    let s1 = score_pick("Aatrox", Role::Top, &state, &c);
    // Pick2: info=0.2 comp=0.8 — same input may produce different composite
    c.phase = Phase::Pick2;
    let s2 = score_pick("Aatrox", Role::Top, &state, &c);
    // For an in-pool champ, pick2's higher comp weight should produce a different
    // blend (unless the placeholder comp/info values happen to coincide).
    assert!(
        s1.composite != s2.composite || s1.compStrength == s1.informationValue,
        "phase weights should blend differently across phases"
    );
}

#[test]
fn blue_red_phase_weights_independent() {
    let blue = default_blue_weights();
    let red = default_red_weights();
    let blue_ban1 = phase_weight_for(Side::Blue, Phase::Ban1, &blue, &red);
    let red_ban1 = phase_weight_for(Side::Red, Phase::Ban1, &blue, &red);
    assert!(blue_ban1.info != red_ban1.info || blue_ban1.comp != red_ban1.comp);
}
