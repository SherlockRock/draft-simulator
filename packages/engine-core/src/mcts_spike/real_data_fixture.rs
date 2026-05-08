//! v5 phase 1: real-data fixture loader.
//!
//! Loads `data/compiled/champion-meta.json` (positions + meta features) and
//! `data/compiled/winrates.json` (per-role winrates from u.gg) and builds a
//! `SpikeFixture` analog of `procedural_fixture::procedural_fixture()`. Used
//! by `mcts_bench`/`ab_sanity` when `--fixture=real` is set.
//!
//! Parsing mirrors `packages/engine-node/src/data_loader.rs`. Duplicated
//! intentionally — the spike doesn't depend on engine-node, and a refactor
//! to share is out of scope for v5 phase 1.

use crate::pools::Role;
use crate::role_solver::{
    CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::SpikeFixture;

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
struct WinratesFile {
    #[serde(rename = "byChampion")]
    by_champion: HashMap<String, HashMap<String, RoleWinrate>>,
}

#[derive(Deserialize)]
struct RoleWinrate {
    wr: f64,
    n: u64,
}

fn parse_role(s: &str) -> Option<Role> {
    match s {
        "TOP" => Some(Role::Top),
        "JUNGLE" => Some(Role::Jungle),
        "MIDDLE" => Some(Role::Middle),
        // champion-meta.json uses Riot's "BOTTOM" for the ADC role.
        "ADC" | "BOTTOM" => Some(Role::Adc),
        "SUPPORT" => Some(Role::Support),
        _ => None,
    }
}

fn convert_entry(entry: ChampionMetaEntry) -> ChampionMeta {
    let positions = entry
        .positions
        .iter()
        .filter_map(|s| parse_role(s))
        .collect();
    ChampionMeta {
        id: entry.id,
        positions,
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
    }
}

/// Pick the most-sampled role's winrate; fall back to fallback (champion-meta
/// winRate, then 0.5). u.gg samples are heavily lane-skewed — using the
/// most-sampled role gives a stable per-champion winrate without having to
/// know which role they'll be assigned at draft time.
fn pick_winrate(
    champion: &str,
    winrates: &HashMap<String, HashMap<String, RoleWinrate>>,
    fallback: f64,
) -> f64 {
    let Some(role_map) = winrates.get(champion) else {
        return if fallback > 0.0 { fallback } else { 0.5 };
    };
    let mut best: Option<(f64, u64)> = None;
    for (_role, rw) in role_map {
        match best {
            None => best = Some((rw.wr, rw.n)),
            Some((_, n)) if rw.n > n => best = Some((rw.wr, rw.n)),
            _ => {}
        }
    }
    match best {
        Some((wr, _)) if wr > 0.0 => wr,
        _ => {
            if fallback > 0.0 {
                fallback
            } else {
                0.5
            }
        }
    }
}

/// Repo root resolved at compile time from `CARGO_MANIFEST_DIR`. Lets the
/// loader find the compiled data files regardless of cwd (so `cargo test`
/// from the package directory works alongside `cargo run` from the workspace
/// root). `SPIKE_CHAMPION_META` / `SPIKE_WINRATES` env overrides take
/// precedence for ad-hoc fixtures.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .expect("engine-core's manifest is two dirs below repo root")
}

fn default_meta_path() -> PathBuf {
    std::env::var("SPIKE_CHAMPION_META")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("data/compiled/champion-meta.json"))
}

fn default_winrates_path() -> PathBuf {
    std::env::var("SPIKE_WINRATES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("data/compiled/winrates.json"))
}

/// Loads real champion meta + per-role winrates and builds a SpikeFixture.
/// Champions are sorted alphabetically in `all_champions` for deterministic
/// iteration order across runs (matters for sanity comparison reproducibility).
pub fn real_data_fixture() -> SpikeFixture {
    load_real_data_fixture(&default_meta_path(), &default_winrates_path())
        .expect("real_data_fixture: failed to load champion-meta.json or winrates.json")
}

pub fn load_real_data_fixture(
    meta_path: &Path,
    winrates_path: &Path,
) -> Result<SpikeFixture, String> {
    let meta_raw = std::fs::read_to_string(meta_path)
        .map_err(|e| format!("read {}: {}", meta_path.display(), e))?;
    let meta_file: ChampionMetaFile = serde_json::from_str(&meta_raw)
        .map_err(|e| format!("parse {}: {}", meta_path.display(), e))?;
    let winrates_raw = std::fs::read_to_string(winrates_path)
        .map_err(|e| format!("read {}: {}", winrates_path.display(), e))?;
    let wr_file: WinratesFile = serde_json::from_str(&winrates_raw)
        .map_err(|e| format!("parse {}: {}", winrates_path.display(), e))?;

    let mut meta: HashMap<String, ChampionMeta> = HashMap::new();
    let mut winrates: HashMap<String, f64> = HashMap::new();
    for (id, entry) in meta_file.champions {
        // Skip champions with no parseable positions (unreleased/disabled
        // entries occasionally ship in champion-meta.json without lane
        // data). Production loader keeps them; spike scoring divides by
        // role coverage and would crash on an empty positions list.
        let has_position = entry
            .positions
            .iter()
            .any(|p| parse_role(p).is_some());
        if !has_position {
            continue;
        }
        let fallback = entry.win_rate;
        let wr = pick_winrate(&id, &wr_file.by_champion, fallback);
        winrates.insert(id.clone(), wr);
        meta.insert(id, convert_entry(entry));
    }

    let mut all_champions: Vec<String> = meta.keys().cloned().collect();
    all_champions.sort();

    Ok(SpikeFixture {
        meta,
        winrates,
        all_champions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_repo_compiled_champion_meta() {
        let fixture = real_data_fixture();
        // ~172 champions in current champion-meta.json. Keep loose to tolerate
        // patch-bumps adding a champ; just verify the loader produced a
        // production-shaped fixture.
        assert!(
            fixture.all_champions.len() >= 150,
            "expected >= 150 champions, got {}",
            fixture.all_champions.len()
        );
        // Spot-check a champion that's been around forever.
        assert!(fixture.meta.contains_key("Aatrox"));
        assert!(fixture.meta.contains_key("Annie"));
        // Annie is in winrates.json with sampled lanes; her winrate should
        // not be the 0.5 fallback (would only land at 0.5 if missing).
        let annie_wr = *fixture.winrates.get("Annie").expect("Annie winrate");
        assert!(
            annie_wr > 0.45 && annie_wr < 0.55,
            "Annie winrate out of plausible band: {}",
            annie_wr
        );
        // Positions should round-trip through parse_role; no champion should
        // have an empty positions list.
        for (id, m) in &fixture.meta {
            assert!(
                !m.positions.is_empty(),
                "champion {} has no parseable positions",
                id
            );
        }
    }

    #[test]
    fn deterministic_champion_ordering() {
        let f1 = real_data_fixture();
        let f2 = real_data_fixture();
        assert_eq!(f1.all_champions, f2.all_champions);
    }
}
