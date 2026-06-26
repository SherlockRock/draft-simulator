use std::collections::HashMap;
use std::path::Path;

use engine_core::evaluator::{MetaData, SynergyRule};
use engine_core::pools::Role;
use engine_core::role_solver::{
    CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
};
use serde::Deserialize;

#[derive(thiserror::Error, Debug)]
pub enum EngineLoadError {
    #[error("read failed at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("parse failed at {path}: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid {field} value {value:?}")]
    InvalidEnum { field: &'static str, value: String },
}

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

fn parse_role(s: &str) -> Result<Role, EngineLoadError> {
    // The compiled champion-meta.json uses "BOTTOM" for the ADC role (Riot's canonical
    // lane name). Engine-core's Role::Adc is the same thing — accept both spellings.
    match s {
        "TOP" => Ok(Role::Top),
        "JUNGLE" => Ok(Role::Jungle),
        "MIDDLE" => Ok(Role::Middle),
        "ADC" | "BOTTOM" => Ok(Role::Adc),
        "SUPPORT" => Ok(Role::Support),
        other => Err(EngineLoadError::InvalidEnum {
            field: "champion.position",
            value: other.to_string(),
        }),
    }
}

fn read_json<T>(path: &Path) -> Result<T, EngineLoadError>
where
    T: serde::de::DeserializeOwned,
{
    let raw = std::fs::read_to_string(path).map_err(|source| EngineLoadError::Io {
        path: path.display().to_string(),
        source,
    })?;
    serde_json::from_str::<T>(&raw).map_err(|source| EngineLoadError::Parse {
        path: path.display().to_string(),
        source,
    })
}

fn convert_entry(entry: ChampionMetaEntry) -> Result<ChampionMeta, EngineLoadError> {
    let positions = entry
        .positions
        .iter()
        .map(|s| parse_role(s))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ChampionMeta {
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
    })
}

/// Loads both files, converts shapes into engine-core types, and merges per-champion
/// `winRate` from `champion-meta.json` into `MetaData::win_rates` (keyed by champion id).
pub fn load_engine_data(
    champion_meta_path: &Path,
    matchup_data_path: &Path,
) -> Result<(MetaData, HashMap<String, ChampionMeta>), EngineLoadError> {
    let champion_file: ChampionMetaFile = read_json(champion_meta_path)?;
    let matchup_file: MatchupDataFile = read_json(matchup_data_path)?;

    let mut champion_meta: HashMap<String, ChampionMeta> =
        HashMap::with_capacity(champion_file.champions.len());
    let mut win_rates: HashMap<String, f64> =
        HashMap::with_capacity(champion_file.champions.len());

    for (id, entry) in champion_file.champions {
        win_rates.insert(id.clone(), entry.win_rate);
        champion_meta.insert(id, convert_entry(entry)?);
    }

    let synergies = matchup_file
        .synergy_rules
        .into_iter()
        .map(|rule| SynergyRule {
            tags: (rule.tags[0].clone(), rule.tags[1].clone()),
            bonus: rule.bonus,
        })
        .collect();

    let meta = MetaData {
        win_rates,
        synergies,
        counters: matchup_file.counters,
    };

    Ok((meta, champion_meta))
}
