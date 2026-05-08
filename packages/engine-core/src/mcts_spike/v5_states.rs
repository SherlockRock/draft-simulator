//! v5 phase 1: shared state + pool fixtures used by `mcts_bench`,
//! `ab_sanity`, and `v5_eval`. Centralizing the (position, fixture, pool)
//! tuples keeps all three binaries aligned — if the spike's empty/late
//! states drift between consumers, sanity-comparison goes silent on the
//! drift, and v3/v4 already taught us what that costs.

use crate::draft_state::DraftState;
use crate::mcts_spike::{PoolContext, SpikeFixture};
use crate::mcts_spike::procedural_fixture::procedural_fixture;
use crate::mcts_spike::real_data_fixture::real_data_fixture;
use crate::pools::{RolePoolMap, TeamPool};

pub fn position_label(idx: usize) -> &'static str {
    match idx {
        0 => "empty",
        1 => "after_bans1",
        2 => "mid_pick1",
        3 => "late",
        _ => "?",
    }
}

pub const POSITION_COUNT: usize = 4;

// --- Procedural fixture states (v4) ---

pub fn procedural_position(idx: usize) -> DraftState {
    match idx {
        0 => DraftState::default(),
        1 => DraftState {
            blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
            red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
            ..Default::default()
        },
        2 => DraftState {
            blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
            red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
            blue_picks: vec!["T01".into()],
            red_picks: vec!["J00".into(), "M04".into()],
            ..Default::default()
        },
        3 => DraftState {
            blue_bans: vec!["T00".into(), "J04".into(), "M08".into(), "T08".into()],
            red_bans: vec!["A00".into(), "S00".into(), "M00".into(), "J08".into()],
            blue_picks: vec!["T01".into(), "M01".into(), "J01".into(), "A01".into()],
            red_picks: vec![
                "J00".into(),
                "M04".into(),
                "T04".into(),
                "A04".into(),
                "S04".into(),
            ],
            ..Default::default()
        },
        _ => unreachable!("position index {} out of range", idx),
    }
}

// --- Real-data fixture states (v5 phase 1) ---

pub fn real_position(idx: usize) -> DraftState {
    match idx {
        0 => DraftState::default(),
        1 => DraftState {
            blue_bans: vec!["Aatrox".into(), "LeeSin".into(), "Yasuo".into()],
            red_bans: vec!["Jinx".into(), "Thresh".into(), "Ahri".into()],
            ..Default::default()
        },
        2 => DraftState {
            blue_bans: vec!["Aatrox".into(), "LeeSin".into(), "Yasuo".into()],
            red_bans: vec!["Jinx".into(), "Thresh".into(), "Ahri".into()],
            blue_picks: vec!["Camille".into()],
            red_picks: vec!["Graves".into(), "Syndra".into()],
            ..Default::default()
        },
        3 => DraftState {
            blue_bans: vec![
                "Aatrox".into(),
                "LeeSin".into(),
                "Yasuo".into(),
                "Akali".into(),
            ],
            red_bans: vec![
                "Jinx".into(),
                "Thresh".into(),
                "Ahri".into(),
                "Graves".into(),
            ],
            blue_picks: vec![
                "Camille".into(),
                "Viego".into(),
                "Syndra".into(),
                "Ezreal".into(),
            ],
            red_picks: vec![
                "Hecarim".into(),
                "Azir".into(),
                "Renekton".into(),
                "Kaisa".into(),
                "Lulu".into(),
            ],
            ..Default::default()
        },
        _ => unreachable!("position index {} out of range", idx),
    }
}

// --- Narrow-pool helpers ---

pub fn procedural_narrow_pool() -> TeamPool {
    let top = vec!["T00".into(), "T01".into(), "T02".into(), "T03".into(), "T04".into()];
    let jg = vec!["J00".into(), "J01".into(), "J02".into(), "J03".into(), "J04".into()];
    let mid = vec!["M00".into(), "M01".into(), "M02".into(), "M03".into(), "M04".into()];
    let adc = vec!["A00".into(), "A01".into(), "A02".into(), "A03".into(), "A04".into()];
    let sup = vec!["S00".into(), "S01".into(), "S02".into(), "S03".into(), "S04".into()];
    let mut search = Vec::new();
    for v in [&top, &jg, &mid, &adc, &sup] {
        search.extend(v.iter().cloned());
    }
    TeamPool { display: RolePoolMap { top, jungle: jg, middle: mid, adc, support: sup }, search }
}

pub fn real_narrow_pool() -> TeamPool {
    let top = vec![
        "Aatrox".into(),
        "Camille".into(),
        "Renekton".into(),
        "Sett".into(),
        "Garen".into(),
    ];
    let jg = vec![
        "Graves".into(),
        "LeeSin".into(),
        "Viego".into(),
        "Hecarim".into(),
        "Kindred".into(),
    ];
    let mid = vec![
        "Ahri".into(),
        "Syndra".into(),
        "Akali".into(),
        "Orianna".into(),
        "Yasuo".into(),
    ];
    let adc = vec![
        "Jinx".into(),
        "Caitlyn".into(),
        "Lucian".into(),
        "Aphelios".into(),
        "Ezreal".into(),
    ];
    let sup = vec![
        "Thresh".into(),
        "Lulu".into(),
        "Karma".into(),
        "Sona".into(),
        "Nautilus".into(),
    ];
    let mut search = Vec::new();
    for v in [&top, &jg, &mid, &adc, &sup] {
        search.extend(v.iter().cloned());
    }
    TeamPool { display: RolePoolMap { top, jungle: jg, middle: mid, adc, support: sup }, search }
}

pub fn build_fixture_and_pools(
    fixture_name: &str,
    pool_name: &str,
) -> (SpikeFixture, PoolContext) {
    let fixture = match fixture_name {
        "real" => real_data_fixture(),
        _ => procedural_fixture(),
    };
    let pools = match (fixture_name, pool_name) {
        (_, "full") => PoolContext::full(&fixture),
        ("real", _) => {
            let pool = real_narrow_pool();
            PoolContext::new(pool.clone(), pool)
        }
        (_, _) => {
            let pool = procedural_narrow_pool();
            PoolContext::new(pool.clone(), pool)
        }
    };
    (fixture, pools)
}

pub fn position_for(fixture_name: &str, idx: usize) -> DraftState {
    match fixture_name {
        "real" => real_position(idx),
        _ => procedural_position(idx),
    }
}
