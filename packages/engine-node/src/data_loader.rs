use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use engine_core::evaluator::{MetaData, SynergyRule};
use engine_core::fm::FmWeights;
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
    #[serde(default = "neutral_win_rate")]
    win_rate: f64,
}

fn neutral_win_rate() -> f64 {
    0.5
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

/// Separate from `load_engine_data` on purpose: that function's single `Result`
/// would make a missing FM fatal (lib.rs:63). Missing/unparseable → `None` +
/// one warning line; construction never fails on the FM (design §4).
pub fn load_fm_weights(path: &Path) -> Option<Arc<FmWeights>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) => {
            eprintln!("fm: absent — legacy compStrength ({}: {err})", path.display());
            return None;
        }
    };
    match FmWeights::from_json_str(&raw) {
        Ok(weights) => Some(Arc::new(weights)),
        Err(err) => {
            eprintln!("fm: unparseable — legacy compStrength ({}: {err})", path.display());
            None
        }
    }
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
        fm: None,
    };

    Ok((meta, champion_meta))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(name: &str, body: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("fm-loader-{}-{name}", std::process::id()));
        std::fs::File::create(&p).unwrap().write_all(body.as_bytes()).unwrap();
        p
    }

    const ENTRY: &str = r#"{"champions":{"Ahri":{"id":"Ahri","positions":["MIDDLE"],
        "damageProfile":{"physical":0.1,"magic":0.9,"true":0.0},
        "scalingProfile":{"early":0.5,"mid":0.6,"late":0.7},
        "ccProfile":{"hasCc":true,"ccTypes":["charm"],"engageQuality":0.5,"peelQuality":0.2},
        "tags":{"archetype":["mage"],"synergy":[]}WIN}}}"#;

    #[test]
    fn a_champion_without_win_rate_defaults_to_a_neutral_half_not_zero() {
        // design §3: 0.0 pinned a fallback champion dead last.
        let meta_path = write_tmp("meta.json", &ENTRY.replace("WIN", ""));
        let matchup_path = write_tmp("matchup.json", r#"{"counters":{},"synergyRules":[]}"#);
        let (meta, _) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(meta.win_rates["Ahri"], 0.5);
        let meta_path = write_tmp("meta2.json", &ENTRY.replace("WIN", r#","winRate":0.52"#));
        let (meta, _) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(meta.win_rates["Ahri"], 0.52);
    }

    #[test]
    fn fm_loader_never_fails_construction() {
        assert!(load_fm_weights(Path::new("/nonexistent/fm-weights.json")).is_none());
        let corrupt = write_tmp("corrupt.json", "{ this is not json");
        assert!(load_fm_weights(&corrupt).is_none());
        let wrong_rank = write_tmp("rank.json", r#"{"version":"x","rank":4,"scale":1.0,"champions":{}}"#);
        assert!(load_fm_weights(&wrong_rank).is_none());
    }

    #[test]
    fn fm_loader_reads_the_shipped_artifact() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let fm = load_fm_weights(&root.join("data/compiled/fm-weights.json")).expect("shipped weights load");
        assert!(fm.len() >= 170);
        assert!(fm.champion("Fiddlesticks").is_some(), "alias must be champion-meta's spelling");
        assert!(fm.champion("FiddleSticks").is_none());
    }
}
