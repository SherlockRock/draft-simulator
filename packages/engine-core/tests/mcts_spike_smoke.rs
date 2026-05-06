//! MCTS spike smoke test. Asserts the loop runs without panicking and
//! produces sensible top-level output. Not a correctness test.

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::SpikeFixture;
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;

fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
    ChampionMeta {
        id: id.to_string(),
        positions,
        ..Default::default()
    }
}

fn small_fixture() -> SpikeFixture {
    // Six champs per role × 5 roles = 30 champs. A few have flex.
    let entries: Vec<(&str, Vec<Role>)> = vec![
        // Top
        ("Garen", vec![Role::Top]),
        ("Darius", vec![Role::Top]),
        ("Sett", vec![Role::Top, Role::Middle]),
        ("Aatrox", vec![Role::Top]),
        ("Renekton", vec![Role::Top]),
        ("Camille", vec![Role::Top]),
        // Jungle
        ("LeeSin", vec![Role::Jungle]),
        ("Graves", vec![Role::Jungle]),
        ("Kindred", vec![Role::Jungle]),
        ("Viego", vec![Role::Jungle, Role::Middle]),
        ("Nidalee", vec![Role::Jungle]),
        ("Hecarim", vec![Role::Jungle]),
        // Middle
        ("Ahri", vec![Role::Middle]),
        ("Syndra", vec![Role::Middle]),
        ("Orianna", vec![Role::Middle]),
        ("Akali", vec![Role::Middle, Role::Top]),
        ("Yasuo", vec![Role::Middle, Role::Top]),
        ("Azir", vec![Role::Middle]),
        // ADC
        ("Jinx", vec![Role::Adc]),
        ("Caitlyn", vec![Role::Adc]),
        ("Aphelios", vec![Role::Adc]),
        ("Ezreal", vec![Role::Adc]),
        ("Kaisa", vec![Role::Adc]),
        ("Lucian", vec![Role::Adc, Role::Middle]),
        // Support
        ("Sona", vec![Role::Support]),
        ("Thresh", vec![Role::Support]),
        ("Nautilus", vec![Role::Support]),
        ("Lulu", vec![Role::Support]),
        ("Pyke", vec![Role::Support]),
        ("Karma", vec![Role::Support, Role::Middle]),
    ];

    let mut meta = HashMap::new();
    let mut winrates = HashMap::new();
    let mut all_champions = Vec::new();
    // Spread winrates 0.45..0.55 deterministically for fixture stability.
    for (i, (name, roles)) in entries.iter().enumerate() {
        meta.insert(name.to_string(), champ(name, roles.clone()));
        let wr = 0.45 + ((i as f64) % 11.0) / 100.0;
        winrates.insert(name.to_string(), wr);
        all_champions.push(name.to_string());
    }
    SpikeFixture {
        meta,
        winrates,
        all_champions,
    }
}

#[test]
fn runs_without_panic_from_empty_draft() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 42,
        },
    );
    for _ in 0..200 {
        mcts.iterate();
    }
    let dist = mcts.root_visit_distribution();
    assert!(!dist.is_empty(), "root should have visited children");
    let total_visits: u32 = dist.iter().map(|(_, v, _)| *v).sum();
    assert!(total_visits > 0, "should have non-zero visits across root children");
    let top = &dist[0];
    assert!(top.1 > 0, "top move should have at least one visit");
}

#[test]
fn winrate_weighted_policy_completes() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::WinrateWeightedFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 7,
        },
    );
    for _ in 0..100 {
        mcts.iterate();
    }
    assert!(mcts.total_iterations() > 0);
}

#[test]
fn from_mid_draft_position() {
    let fixture = small_fixture();
    // 6 bans + 3 picks done — partway through pick 1 phase.
    let state = DraftState {
        blue_bans: vec![
            "Yasuo".to_string(),
            "Akali".to_string(),
            "Viego".to_string(),
        ],
        red_bans: vec![
            "Lucian".to_string(),
            "Karma".to_string(),
            "Sett".to_string(),
        ],
        blue_picks: vec!["Garen".to_string()],
        red_picks: vec!["LeeSin".to_string(), "Ahri".to_string()],
        ..Default::default()
    };
    let mut mcts = Mcts::new(
        &fixture,
        state,
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 1,
        },
    );
    for _ in 0..150 {
        mcts.iterate();
    }
    let dist = mcts.root_visit_distribution();
    assert!(!dist.is_empty());
}

#[test]
fn uncached_feasibility_also_works() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Uncached,
            seed: 99,
        },
    );
    for _ in 0..50 {
        mcts.iterate();
    }
    assert!(mcts.total_iterations() > 0);
}
