//! Spike's procedural champion fixture: 76 champions across 5 roles with
//! deterministic winrates and a sprinkle of flex (every 4th champion gets
//! a secondary role). Used by `examples/mcts_bench`, `examples/ab_sanity`,
//! `examples/mcts_full_draft`, and the v4 late-position smoke test so they
//! all see the same draft universe. v4 added — v3 had duplicated copies.

use crate::pools::Role;
use crate::role_solver::ChampionMeta;
use std::collections::HashMap;

use super::SpikeFixture;

/// 76 champions: T00-T15 (16 Tops), J00-J15 (16 Junglers), M00-M15 (16 Mids),
/// A00-A13 (14 ADCs), S00-S13 (14 Supports). Every i%4==0 champion has a
/// secondary role (the role's `flex_opts` first entry).
pub fn procedural_fixture() -> SpikeFixture {
    let role_layout: &[(Role, &[Role], usize)] = &[
        (Role::Top, &[Role::Middle], 16),
        (Role::Jungle, &[Role::Top], 16),
        (Role::Middle, &[Role::Top], 16),
        (Role::Adc, &[Role::Middle], 14),
        (Role::Support, &[Role::Middle], 14),
    ];
    let mut meta: HashMap<String, ChampionMeta> = HashMap::new();
    let mut winrates: HashMap<String, f64> = HashMap::new();
    let mut all_champions: Vec<String> = Vec::new();
    let role_letter = |r: Role| match r {
        Role::Top => "T",
        Role::Jungle => "J",
        Role::Middle => "M",
        Role::Adc => "A",
        Role::Support => "S",
    };
    for (primary, flex_opts, count) in role_layout {
        for i in 0..*count {
            let id = format!("{}{:02}", role_letter(*primary), i);
            let positions = if i % 4 == 0 && !flex_opts.is_empty() {
                vec![*primary, flex_opts[0]]
            } else {
                vec![*primary]
            };
            meta.insert(
                id.clone(),
                ChampionMeta {
                    id: id.clone(),
                    positions,
                    ..Default::default()
                },
            );
            let wr = 0.46 + (((i * 7) % 9) as f64) / 100.0;
            winrates.insert(id.clone(), wr);
            all_champions.push(id);
        }
    }
    SpikeFixture { meta, winrates, all_champions }
}
