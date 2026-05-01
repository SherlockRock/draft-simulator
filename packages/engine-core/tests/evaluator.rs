use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::{
    phase_weight_for, score_pick, EvalContext, MetaData, PhaseWeightTable, PhaseWeights,
};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;

fn default_blue_weights() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.65, comp: 0.35, coverage: 0.0 },
        pick1: PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 },
        ban2: PhaseWeights { info: 0.4, comp: 0.6, coverage: 0.0 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8, coverage: 0.0 },
    }
}

fn default_red_weights() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.7, comp: 0.3, coverage: 0.0 },
        pick1: PhaseWeights { info: 0.6, comp: 0.4, coverage: 0.0 },
        ban2: PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8, coverage: 0.0 },
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
        ChampionMeta {
            id: "Aatrox".into(),
            positions: vec![Role::Top],
            ..Default::default()
        },
    );
    champion_meta.insert(
        "Vi".into(),
        ChampionMeta {
            id: "Vi".into(),
            positions: vec![Role::Jungle],
            ..Default::default()
        },
    );
    champion_meta.insert(
        "Ahri".into(),
        ChampionMeta {
            id: "Ahri".into(),
            positions: vec![Role::Middle],
            ..Default::default()
        },
    );
    champion_meta.insert(
        "Jinx".into(),
        ChampionMeta {
            id: "Jinx".into(),
            positions: vec![Role::Adc],
            ..Default::default()
        },
    );
    champion_meta.insert(
        "Nautilus".into(),
        ChampionMeta {
            id: "Nautilus".into(),
            positions: vec![Role::Support],
            ..Default::default()
        },
    );
    champion_meta.insert(
        "Yone".into(),
        ChampionMeta {
            id: "Yone".into(),
            positions: vec![Role::Middle, Role::Top],
            ..Default::default()
        },
    );

    EvalContext {
        side: Side::Blue,
        phase: Phase::Pick1,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks: Vec::new(),
        opp_picks: Vec::new(),
        penalties,
        champion_meta,
        meta: MetaData::default(),
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
    let aatrox_top = score_pick("Aatrox", Role::Top, &state, &c, ActionType::Pick);
    // Aatrox in JUNGLE role → out-of-role penalty (× 0.75)
    let aatrox_jng = score_pick("Aatrox", Role::Jungle, &state, &c, ActionType::Pick);
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
    let s1 = score_pick("Aatrox", Role::Top, &state, &c, ActionType::Pick);
    // Pick2: info=0.2 comp=0.8 — same input may produce different composite
    c.phase = Phase::Pick2;
    let s2 = score_pick("Aatrox", Role::Top, &state, &c, ActionType::Pick);
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

#[test]
fn comp_strength_uses_win_rate_baseline() {
    let mut c = ctx();
    c.meta.win_rates.insert("Aatrox".into(), 0.55);
    let state = DraftState::default();
    let s = score_pick("Aatrox", Role::Top, &state, &c, ActionType::Pick);
    // Without synergy/counter contributions, compStrength ≈ win_rate
    assert!((s.compStrength - 0.55).abs() < 0.05);
}

#[test]
fn flex_retention_high_for_flex_comp() {
    let mut c = ctx();
    c.our_picks = vec![
        "Yone".into(),
        "Vi".into(),
        "Ahri".into(),
        "Jinx".into(),
        "Nautilus".into(),
    ];
    let state = DraftState::default();
    let s = score_pick("Yone", Role::Middle, &state, &c, ActionType::Pick);
    assert!(
        s.flexRetention > 0.0,
        "flex comp should have non-zero flex retention: got {}",
        s.flexRetention
    );
}

#[test]
fn reveal_cost_complement_of_flex() {
    let mut c = ctx();
    c.our_picks = vec![
        "Aatrox".into(),
        "Vi".into(),
        "Ahri".into(),
        "Jinx".into(),
        "Nautilus".into(),
    ];
    let state = DraftState::default();
    let s = score_pick("Aatrox", Role::Top, &state, &c, ActionType::Pick);
    assert!((s.flexRetention + s.revealCost - 1.0).abs() < 0.05);
}

#[test]
fn comp_strength_punishes_counter() {
    let mut c = ctx();
    c.meta.win_rates.insert("Aatrox".into(), 0.50);
    c.opp_picks = vec!["Renekton".into()];
    let mut renekton_counter = HashMap::new();
    renekton_counter.insert("Renekton".into(), -0.10);
    let mut counters = HashMap::new();
    counters.insert("Aatrox".into(), renekton_counter);
    c.meta.counters = counters;

    let state = DraftState::default();
    let s = score_pick("Aatrox", Role::Top, &state, &c, ActionType::Pick);
    assert!(
        s.compStrength < 0.50,
        "Counter risk must reduce compStrength: got {}",
        s.compStrength
    );
}
