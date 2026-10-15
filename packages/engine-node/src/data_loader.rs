use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use engine_core::coverage::ROLES;
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
    /// `positionShares` does not match `positions` (engine-role-grade design § 1).
    #[error("champion {id}: {reason}")]
    InvalidShares { id: String, reason: String },
    /// `playable` lacks a listed position (champion-role-shares design § 4.1: `positions ⊆ playable`,
    /// the invariant the engine's fallback assumes).
    #[error("champion {id}: {reason}")]
    InvalidPlayable { id: String, reason: String },
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
    /// `positionShares` (engine-role-grade design § 1): absent on a file from before the shares.
    #[serde(default)]
    position_shares: HashMap<String, f64>,
    /// `playable` (champion-role-shares design § 4.1): the engine's legality set; absent on a file
    /// from before the field — `ChampionMeta::playable_roles` then falls back to the positions.
    #[serde(default)]
    playable: Vec<String>,
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

/// `positionShares` as FIVE values aligned with `ROLES` (champion-role-shares design § 4.1): the
/// five-key map the refresh writes, or the legacy listed-key map of the 2026-09-05 tables (an absent
/// role is 0); empty when the file has none. A key outside the vocabulary, a value outside [0, 1] and
/// an all-zero map are load errors naming the champion — a present all-zero row would divide the
/// factor and the grade by zero. NO ordering rule: the largest share may sit at any role (an override
/// may reorder `positions`); every consumer divides by `ChampionMeta::max_share`.
fn aligned_shares(id: &str, shares: &HashMap<String, f64>) -> Result<Vec<f64>, EngineLoadError> {
    if shares.is_empty() {
        return Ok(Vec::new());
    }
    let invalid = |reason: String| EngineLoadError::InvalidShares {
        id: id.to_string(),
        reason,
    };
    let mut keys: Vec<&String> = shares.keys().collect();
    keys.sort();
    let mut aligned = vec![0.0; ROLES.len()];
    for key in keys {
        let role = parse_role(key)
            .map_err(|_| invalid(format!("positionShares names {key}, which is not a role")))?;
        let value = shares[key];
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err(invalid(format!(
                "positionShares.{key} = {value} is not a finite number in [0, 1]"
            )));
        }
        let bit = ROLES
            .iter()
            .position(|r| *r == role)
            .expect("ROLES holds every Role");
        aligned[bit] = value;
    }
    if aligned.iter().all(|s| *s <= 0.0) {
        return Err(invalid("positionShares are all zero".to_string()));
    }
    Ok(aligned)
}

fn convert_entry(entry: ChampionMetaEntry) -> Result<ChampionMeta, EngineLoadError> {
    let positions = entry
        .positions
        .iter()
        .map(|s| parse_role(s))
        .collect::<Result<Vec<_>, _>>()?;
    let position_shares = aligned_shares(&entry.id, &entry.position_shares)?;
    let playable = entry
        .playable
        .iter()
        .map(|s| parse_role(s))
        .collect::<Result<Vec<_>, _>>()?;
    if !playable.is_empty() {
        if let Some((name, _)) = entry
            .positions
            .iter()
            .zip(&positions)
            .find(|(_, role)| !playable.contains(role))
        {
            return Err(EngineLoadError::InvalidPlayable {
                id: entry.id,
                reason: format!("playable lacks the listed position {name}"),
            });
        }
    }
    Ok(ChampionMeta {
        id: entry.id,
        positions,
        position_shares,
        playable,
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

    /// champion-role-shares design § 4.1 / § 4.2 hop 6: `positionShares` parses into FIVE values aligned
    /// with `ROLES` (Top, Jungle, Middle, Adc, Support) whatever order the map's keys come in; a legacy
    /// listed-key map (the 2026-09-05 frozen tables) loads with 0 for every absent role; absent → empty
    /// (`share_of` is then `None`); a key outside the vocabulary, a value outside [0, 1] and an all-zero
    /// map are load errors naming the champion. No ordering rule: the largest share may sit anywhere.
    #[test]
    fn position_shares_parse_aligned_with_the_five_roles() {
        let matchup_path = write_tmp(
            "matchup-shares.json",
            r#"{"counters":{},"synergyRules":[]}"#,
        );
        let with = |shares: &str| {
            ENTRY.replace("WIN", "").replace(
                r#""positions":["MIDDLE"]"#,
                &format!(r#""positions":["MIDDLE","BOTTOM"]{shares}"#),
            )
        };
        let meta_path = write_tmp(
            "meta-shares.json",
            &with(
                r#","positionShares":{"BOTTOM":0.3,"MIDDLE":0.6,"SUPPORT":0,"TOP":0.1,"JUNGLE":0}"#,
            ),
        );
        let (_, meta) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(
            meta["Ahri"].position_shares,
            vec![0.1, 0.0, 0.6, 0.3, 0.0],
            "aligned with ROLES, not the map's order"
        );
        assert_eq!(meta["Ahri"].share_of(Role::Adc), Some(0.3));
        assert_eq!(
            meta["Ahri"].share_of(Role::Top),
            Some(0.1),
            "an unlisted role's share is read"
        );
        assert_eq!(meta["Ahri"].max_share(), Some(0.6));
        // The legacy listed-key shape: absent roles are 0.
        let meta_path = write_tmp(
            "meta-legacy-shares.json",
            &with(r#","positionShares":{"BOTTOM":0.3,"MIDDLE":0.6}"#),
        );
        let (_, meta) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(meta["Ahri"].position_shares, vec![0.0, 0.0, 0.6, 0.3, 0.0]);
        assert_eq!(meta["Ahri"].share_of(Role::Top), Some(0.0));
        // A reordered-primary override: accepted, the maximum is wherever it is.
        let meta_path = write_tmp(
            "meta-reordered-shares.json",
            &with(r#","positionShares":{"MIDDLE":0.3,"BOTTOM":0.6}"#),
        );
        let (_, meta) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(meta["Ahri"].max_share(), Some(0.6));
        let meta_path = write_tmp("meta-noshares.json", &with(""));
        let (_, meta) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(meta["Ahri"].position_shares, Vec::<f64>::new());
        assert_eq!(meta["Ahri"].share_of(Role::Middle), None);
        assert_eq!(meta["Ahri"].max_share(), None);
        let refused = |name: &str, shares: &str, needle: &str| {
            let meta_path = write_tmp(name, &with(shares));
            let Err(err) = load_engine_data(&meta_path, &matchup_path) else {
                panic!("{shares} must fail");
            };
            assert!(err.to_string().contains(needle), "{shares}: {err}");
        };
        refused(
            "meta-shares-utility.json",
            r#","positionShares":{"MIDDLE":0.6,"BOTTOM":0.3,"UTILITY":0.1}"#,
            "positionShares names UTILITY, which is not a role",
        );
        refused(
            "meta-shares-over.json",
            r#","positionShares":{"MIDDLE":1.6,"BOTTOM":0.3}"#,
            "positionShares.MIDDLE = 1.6 is not a finite number in [0, 1]",
        );
        refused(
            "meta-shares-negative.json",
            r#","positionShares":{"MIDDLE":-0.1,"BOTTOM":0.3}"#,
            "positionShares.MIDDLE = -0.1 is not a finite number in [0, 1]",
        );
        refused(
            "meta-shares-zero.json",
            r#","positionShares":{"MIDDLE":0,"BOTTOM":0}"#,
            "positionShares are all zero",
        );
    }

    /// champion-role-shares design § 4.1 / § 4.2 hop 6: `playable` parses through `parse_role` like
    /// `positions` (BOTTOM and ADC both spell Adc); absent it is empty and `playable_roles()` falls
    /// back to the positions; a vocabulary miss and a list that lacks a listed position are load
    /// errors naming the champion (the engine's fallback assumes `positions ⊆ playable`).
    #[test]
    fn playable_parses_like_positions_and_falls_back_to_them() {
        let matchup_path = write_tmp(
            "matchup-playable.json",
            r#"{"counters":{},"synergyRules":[]}"#,
        );
        let with = |tail: &str| ENTRY.replace("WIN", tail);
        let meta_path = write_tmp(
            "meta-playable.json",
            &with(r#","playable":["MIDDLE","BOTTOM","TOP"]"#),
        );
        let (_, meta) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(
            meta["Ahri"].playable,
            vec![Role::Middle, Role::Adc, Role::Top]
        );
        assert_eq!(
            meta["Ahri"].playable_roles(),
            &[Role::Middle, Role::Adc, Role::Top]
        );
        assert_eq!(
            meta["Ahri"].positions,
            vec![Role::Middle],
            "positions stay the UI's set"
        );
        let meta_path = write_tmp("meta-noplayable.json", &with(""));
        let (_, meta) = load_engine_data(&meta_path, &matchup_path).unwrap();
        assert_eq!(meta["Ahri"].playable, Vec::<Role>::new());
        assert_eq!(
            meta["Ahri"].playable_roles(),
            &[Role::Middle],
            "absent → the positions"
        );
        let meta_path = write_tmp(
            "meta-playable-utility.json",
            &with(r#","playable":["MIDDLE","UTILITY"]"#),
        );
        let Err(err) = load_engine_data(&meta_path, &matchup_path) else {
            panic!("a vocabulary miss must fail");
        };
        assert!(err.to_string().contains("UTILITY"), "{err}");
        let meta_path = write_tmp("meta-playable-narrow.json", &with(r#","playable":["TOP"]"#));
        let Err(err) = load_engine_data(&meta_path, &matchup_path) else {
            panic!("a playable list lacking a listed position must fail");
        };
        assert!(
            err.to_string()
                .contains("playable lacks the listed position MIDDLE"),
            "{err}"
        );
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
