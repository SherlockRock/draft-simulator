//! Production-config helpers shared by the integration tests that run the
//! engine against the real compiled data files.
//!
//! Moved here verbatim from `leaf_eval_stats.rs` when `fm_search_ab.rs` needed
//! the same loader and the same backend configuration. Rust compiles each file
//! under `tests/` into its own binary, so a shared module is the only way to
//! have one copy; `tests/common/mod.rs` is the standard location.
//!
//! Not every test binary uses every helper, hence the module-wide `dead_code`
//! allowance.
#![allow(dead_code)]

use engine_core::draft_state::{DraftState, Side};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights, SynergyRule};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::{
    CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Production data. engine-node owns `data_loader::load_engine_data` but that
// module is private and engine-core cannot depend on engine-node, so this is a
// local parse of the same two compiled files. Kept minimal — only the fields
// the search actually reads.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChampionMetaFile {
    champions: HashMap<String, ChampionMetaEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChampionMetaEntry {
    id: String,
    positions: Vec<String>,
    damage_profile: DamageProfileFile,
    scaling_profile: ScalingProfileFile,
    cc_profile: CcProfileFile,
    tags: ChampionTagsFile,
    #[serde(default)]
    win_rate: f64,
}

#[derive(Deserialize)]
struct DamageProfileFile {
    physical: f64,
    magic: f64,
    #[serde(rename = "true")]
    true_dmg: f64,
}

#[derive(Deserialize)]
struct ScalingProfileFile {
    early: f64,
    mid: f64,
    late: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcProfileFile {
    has_cc: bool,
    cc_types: Vec<String>,
    engage_quality: f64,
    peel_quality: f64,
}

#[derive(Deserialize)]
struct ChampionTagsFile {
    archetype: Vec<String>,
    synergy: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchupDataFile {
    #[serde(default)]
    counters: HashMap<String, HashMap<String, f64>>,
    #[serde(default)]
    synergy_rules: Vec<SynergyRuleFile>,
}

#[derive(Deserialize)]
struct SynergyRuleFile {
    tags: [String; 2],
    bonus: f64,
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("engine-core lives at packages/engine-core")
        .to_path_buf()
}

pub fn parse_role(s: &str) -> Role {
    // champion-meta.json uses Riot's "BOTTOM" for what engine-core calls Adc.
    match s {
        "TOP" => Role::Top,
        "JUNGLE" => Role::Jungle,
        "MIDDLE" => Role::Middle,
        "ADC" | "BOTTOM" => Role::Adc,
        "SUPPORT" => Role::Support,
        other => panic!("unknown position {other:?} in champion-meta.json"),
    }
}

pub fn load_production_data() -> (MetaData, HashMap<String, ChampionMeta>) {
    let root = repo_root();
    let champion_file: ChampionMetaFile = serde_json::from_str(
        &std::fs::read_to_string(root.join("data/compiled/champion-meta.json"))
            .expect("data/compiled/champion-meta.json"),
    )
    .expect("champion-meta.json parses");
    let matchup_file: MatchupDataFile = serde_json::from_str(
        &std::fs::read_to_string(root.join("data/compiled/matchup-data.json"))
            .expect("data/compiled/matchup-data.json"),
    )
    .expect("matchup-data.json parses");

    let mut champion_meta = HashMap::new();
    let mut win_rates = HashMap::new();
    for (id, entry) in champion_file.champions {
        win_rates.insert(id.clone(), entry.win_rate);
        champion_meta.insert(
            id,
            ChampionMeta {
                id: entry.id,
                positions: entry.positions.iter().map(|s| parse_role(s)).collect(),
                damage_profile: DamageProfile {
                    physical: entry.damage_profile.physical,
                    magic: entry.damage_profile.magic,
                    r#true: entry.damage_profile.true_dmg,
                },
                scaling_profile: ScalingProfile {
                    early: entry.scaling_profile.early,
                    mid: entry.scaling_profile.mid,
                    late: entry.scaling_profile.late,
                },
                cc_profile: CcProfile {
                    has_cc: entry.cc_profile.has_cc,
                    cc_types: entry.cc_profile.cc_types,
                    engage_quality: entry.cc_profile.engage_quality,
                    peel_quality: entry.cc_profile.peel_quality,
                },
                tags: ChampionTags {
                    archetype: entry.tags.archetype,
                    synergy: entry.tags.synergy,
                },
            },
        );
    }

    let meta = MetaData {
        win_rates,
        synergies: matchup_file
            .synergy_rules
            .into_iter()
            .map(|r| SynergyRule {
                tags: (r.tags[0].clone(), r.tags[1].clone()),
                bonus: r.bonus,
            })
            .collect(),
        counters: matchup_file.counters,
        fm: None,
    };
    (meta, champion_meta)
}

// ---------------------------------------------------------------------------
// The backend's production config, copied verbatim.
// ---------------------------------------------------------------------------

/// backend/services/navigatorEngine.js:31-43 DEFAULT_PHASE_WEIGHTS.blue
pub fn phase_weights_blue() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { comp: 0.35, info: 0.65, coverage: 0.0 },
        pick1: PhaseWeights { comp: 0.5, info: 0.5, coverage: 0.3 },
        ban2: PhaseWeights { comp: 0.6, info: 0.4, coverage: 0.4 },
        pick2: PhaseWeights { comp: 0.8, info: 0.2, coverage: 1.5 },
    }
}

/// backend/services/navigatorEngine.js:31-43 DEFAULT_PHASE_WEIGHTS.red
pub fn phase_weights_red() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { comp: 0.3, info: 0.7, coverage: 0.0 },
        pick1: PhaseWeights { comp: 0.4, info: 0.6, coverage: 0.3 },
        ban2: PhaseWeights { comp: 0.5, info: 0.5, coverage: 0.4 },
        pick2: PhaseWeights { comp: 0.8, info: 0.2, coverage: 1.5 },
    }
}

pub fn full_roster_pool(champion_meta: &HashMap<String, ChampionMeta>) -> TeamPool {
    // The backend sends session pools; an unconfigured session sends the whole
    // roster as the search list. That is the widest realistic candidate set and
    // therefore the honest upper bound for a throughput gate.
    let mut search: Vec<String> = champion_meta.keys().cloned().collect();
    search.sort();
    TeamPool {
        display: RolePoolMap {
            top: vec![],
            jungle: vec![],
            middle: vec![],
            adc: vec![],
            support: vec![],
        },
        search,
    }
}

pub fn eval_context(
    state: &DraftState,
    our_side: Side,
    champion_meta: &HashMap<String, ChampionMeta>,
    meta: &MetaData,
) -> EvalContext {
    let pool = full_roster_pool(champion_meta);
    let phase = state
        .current_turn()
        .map(|t| t.phase)
        .unwrap_or(engine_core::draft_state::Phase::Pick2);
    let (our_picks, opp_picks) = if our_side == Side::Blue {
        (state.blue_picks.clone(), state.red_picks.clone())
    } else {
        (state.red_picks.clone(), state.blue_picks.clone())
    };
    EvalContext {
        side: our_side,
        phase,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks,
        opp_picks,
        // backend/services/navigatorEngine.js:167
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        champion_meta: champion_meta.clone(),
        meta: meta.clone(),
        phase_weights_blue: phase_weights_blue(),
        phase_weights_red: phase_weights_red(),
        // backend/services/navigatorEngine.js:168-171
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
        fm: None,
    }
}
