//! Tier A fixture files (design § 5, D6): one JSON per fixture, validated on load so a
//! mis-authored fixture fails with its field named rather than as a wrong answer.

use super::feasibility::FeasibilityRule;
use super::format::{Format, Turn};
use super::state::{Action, Entry, Pools, Position, PositionError};
use super::universe::{ChampionSet, Universe, UniverseSpec};
use crate::draft_state::{ActionType, Side};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Which oracle a fixture asks for (design § 4). Depth is counted in turns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    FullRemainder,
    Horizon(usize),
}

/// Written by the Python prototype (`--write-stats`), asserted exactly by the harness.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct DryRun {
    pub value: f64,
    pub leaves: u64,
    pub nodes: u64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FormatSpec {
    Named(String),
    Explicit { turns: Vec<Turn> },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OracleSpec {
    Named(String),
    Horizon { horizon: usize },
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Ban,
    Pick,
    Skip,
}

#[derive(Deserialize)]
struct EntrySpec {
    slot: usize,
    side: Side,
    kind: EntryKind,
    #[serde(default)]
    champion: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ExpectedSpec {
    Single(String),
    Pair([String; 2]),
}

#[derive(Deserialize)]
struct PoolsSpec {
    blue: Vec<String>,
    red: Vec<String>,
}

fn default_epsilon() -> f64 {
    1e-9
}

#[derive(Deserialize)]
struct FixtureFile {
    id: String,
    tactic: u32,
    notes: String,
    format: FormatSpec,
    feasibility: FeasibilityRule,
    universe: UniverseSpec,
    pools: PoolsSpec,
    position: Vec<EntrySpec>,
    oracle: OracleSpec,
    expected_top: Vec<ExpectedSpec>,
    #[serde(default = "default_epsilon")]
    epsilon: f64,
    dry_run: DryRun,
}

#[derive(Debug, thiserror::Error)]
pub enum FixtureError {
    #[error("{path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{label}: {source}")]
    Json {
        label: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("{id}: {field}: {reason}")]
    Invalid {
        id: String,
        field: String,
        reason: String,
    },
}

#[derive(Clone, Debug)]
pub struct Fixture {
    pub id: String,
    pub tactic: u32,
    pub notes: String,
    pub path: Option<PathBuf>,
    pub format: Format,
    pub feasibility: FeasibilityRule,
    pub universe: Universe,
    pub pools: Pools,
    pub entries: Vec<Entry>,
    pub mode: Mode,
    pub expected_top: Vec<Action>,
    pub epsilon: f64,
    pub dry_run: DryRun,
}

impl Fixture {
    pub fn load_file(path: &Path) -> Result<Self, FixtureError> {
        let raw = std::fs::read_to_string(path).map_err(|source| FixtureError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let mut fixture = Self::from_json(&raw, &path.display().to_string())?;
        fixture.path = Some(path.to_path_buf());
        Ok(fixture)
    }

    /// Every `*.json` in `dir`, sorted by file name.
    pub fn load_dir(dir: &Path) -> Result<Vec<Self>, FixtureError> {
        let entries = std::fs::read_dir(dir).map_err(|source| FixtureError::Io {
            path: dir.to_path_buf(),
            source,
        })?;
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
            .collect();
        paths.sort();
        paths.iter().map(|p| Self::load_file(p)).collect()
    }

    pub fn from_json(raw: &str, label: &str) -> Result<Self, FixtureError> {
        let file: FixtureFile = serde_json::from_str(raw).map_err(|source| FixtureError::Json {
            label: label.to_string(),
            source,
        })?;
        let id = file.id.clone();
        let invalid = |field: &str, reason: String| FixtureError::Invalid {
            id: id.clone(),
            field: field.to_string(),
            reason,
        };

        let format = match file.format {
            FormatSpec::Named(name) if name == "standard" => Format::standard(),
            FormatSpec::Named(name) => {
                return Err(invalid(
                    "format",
                    format!(
                        "unknown named format {name:?}; use \"standard\" or {{\"turns\": […]}}"
                    ),
                ))
            }
            FormatSpec::Explicit { turns } => Format::explicit(turns),
        };

        let five_picks =
            format.picks_per_side(Side::Blue) == 5 && format.picks_per_side(Side::Red) == 5;
        if file.feasibility == FeasibilityRule::On && !five_picks {
            return Err(invalid(
                "feasibility",
                "\"on\" needs five picks a side (the predicate is defined only there); declare \"off\" and say why in notes".into(),
            ));
        }

        let universe =
            Universe::new(file.universe).map_err(|e| invalid("universe", e.to_string()))?;
        let lookup = |field: &str, name: &str| {
            universe
                .index(name)
                .ok_or_else(|| invalid(field, format!("unknown champion {name:?}")))
        };

        let mut pools = Pools::default();
        for name in &file.pools.blue {
            pools.blue = pools.blue.with(lookup("pools.blue", name)?);
        }
        for name in &file.pools.red {
            pools.red = pools.red.with(lookup("pools.red", name)?);
        }

        let mut entries = Vec::with_capacity(file.position.len());
        for (i, e) in file.position.iter().enumerate() {
            let field = |suffix: &str| format!("position[{i}].{suffix}");
            if e.slot != i {
                return Err(invalid(
                    &field("slot"),
                    format!("slot {} at index {i}", e.slot),
                ));
            }
            let slot = format
                .slot(i)
                .ok_or_else(|| invalid(&field("slot"), "beyond the format".into()))?;
            if e.side != slot.side {
                return Err(invalid(
                    &field("side"),
                    format!("the format's slot {i} belongs to {:?}", slot.side),
                ));
            }
            let expected_kind = match slot.action {
                ActionType::Ban => EntryKind::Ban,
                ActionType::Pick => EntryKind::Pick,
            };
            if e.kind != expected_kind
                && !(e.kind == EntryKind::Skip && slot.action == ActionType::Ban)
            {
                return Err(invalid(
                    &field("kind"),
                    format!("the format's slot {i} is a {:?}", slot.action),
                ));
            }
            let entry = match (e.kind, &e.champion) {
                (EntryKind::Skip, None) => Entry::Skip,
                (EntryKind::Skip, Some(_)) => {
                    return Err(invalid(
                        &field("champion"),
                        "a skip names no champion".into(),
                    ))
                }
                (_, None) => return Err(invalid(&field("champion"), "missing".into())),
                (EntryKind::Ban, Some(name)) => Entry::Ban(lookup(&field("champion"), name)?),
                (EntryKind::Pick, Some(name)) => Entry::Pick(lookup(&field("champion"), name)?),
            };
            entries.push(entry);
        }
        // Position::new re-checks kinds and adds duplicate / pool checks; its errors are position-level.
        let position = Position::new(&format, &entries, &pools, &universe)
            .map_err(|e: PositionError| invalid("position", e.to_string()))?;
        let root = position.next_slot().ok_or_else(|| {
            invalid(
                "position",
                "the draft is complete; nothing to evaluate".into(),
            )
        })?;

        let mode = match file.oracle {
            OracleSpec::Named(name) if name == "full_remainder" => Mode::FullRemainder,
            OracleSpec::Named(name) => {
                return Err(invalid(
                    "oracle",
                    format!(
                        "unknown oracle {name:?}; use \"full_remainder\" or {{\"horizon\": h}}"
                    ),
                ))
            }
            OracleSpec::Horizon { horizon: 0 } => {
                return Err(invalid(
                    "oracle",
                    "a horizon of 0 evaluates the root and decides nothing".into(),
                ))
            }
            OracleSpec::Horizon { horizon } => Mode::Horizon(horizon),
        };

        if file.expected_top.is_empty() {
            return Err(invalid("expected_top", "empty".into()));
        }
        let mut expected_top = Vec::with_capacity(file.expected_top.len());
        for (i, e) in file.expected_top.iter().enumerate() {
            let field = format!("expected_top[{i}]");
            let action = match e {
                ExpectedSpec::Single(name) => {
                    let c = lookup(&field, name)?;
                    match root.action {
                        ActionType::Ban => Action::Ban(c),
                        ActionType::Pick if !root.pair_start => Action::Pick(c),
                        ActionType::Pick => {
                            return Err(invalid(
                                &field,
                                "the root is a pair turn; expected actions are [a, b] pairs".into(),
                            ))
                        }
                    }
                }
                ExpectedSpec::Pair([a, b]) => {
                    if !root.pair_start {
                        return Err(invalid(
                            &field,
                            "the root is not a pair turn; expected actions are single ids".into(),
                        ));
                    }
                    let (a, b) = (lookup(&field, a)?, lookup(&field, b)?);
                    if a == b {
                        return Err(invalid(&field, "a pair of the same champion".into()));
                    }
                    Action::pair(a, b)
                }
            };
            if expected_top.contains(&action) {
                return Err(invalid(&field, "duplicate".into()));
            }
            expected_top.push(action);
        }
        expected_top.sort();

        Ok(Self {
            id: file.id,
            tactic: file.tactic,
            notes: file.notes,
            path: None,
            format,
            feasibility: file.feasibility,
            universe,
            pools,
            entries,
            mode,
            expected_top,
            epsilon: file.epsilon,
            dry_run: file.dry_run,
        })
    }

    /// The root position. Validated at load, so a failure here is a programming error.
    pub fn position(&self) -> Position<'_> {
        Position::new(&self.format, &self.entries, &self.pools, &self.universe)
            .expect("fixture position was validated at load")
    }

    /// For every completed pair on the board, the entry list with that pair's two picks swapped
    /// (design § 6: pair-order equivalence). A half-filled pair at the root is not a completed pair.
    pub fn swapped_pairs(&self) -> Vec<(usize, Vec<Entry>)> {
        let mut out = Vec::new();
        for (i, slot) in self.format.slots().iter().enumerate() {
            if slot.pair_start && i + 1 < self.entries.len() {
                if let (Entry::Pick(_), Entry::Pick(_)) = (self.entries[i], self.entries[i + 1]) {
                    let mut swapped = self.entries.clone();
                    swapped.swap(i, i + 1);
                    out.push((i, swapped));
                }
            }
        }
        out
    }

    pub fn available(&self) -> ChampionSet {
        self.position().available(&self.universe)
    }
}
