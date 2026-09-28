//! Tier A fixture files (design § 5, D6): one JSON per fixture, validated on load so a
//! mis-authored fixture fails with its field named rather than as a wrong answer. Entry, pool and
//! action specs are the shared ones in `super::entries` (slice-5 U7).

use super::entries::{
    spec_to_action, spec_to_entries, spec_to_pools, ActionSpec, EntrySpec, PoolsSpec, SpecError,
};
use super::feasibility::FeasibilityRule;
use super::format::{Format, Turn};
use super::objective::Objective;
use super::oracle::{evaluate, Evaluation, OracleError, OracleInput};
use super::state::{Action, Entry, Pools, Position, PositionError};
use super::universe::{ChampionSet, Universe, UniverseSpec};
use crate::draft_state::Side;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Which oracle a fixture asks for (design § 4). Depth is counted in turns.
pub use super::oracle::Mode;

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

fn default_epsilon() -> f64 {
    1e-9
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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
    expected_top: Vec<ActionSpec>,
    #[serde(default = "default_epsilon")]
    epsilon: f64,
    dry_run: DryRun,
    /// Slice 4 (design § 6): the author declares that the top line legitimately breaks the OPPONENT's
    /// comp (a denial). The harness asserts the declaration two-sidedly and that a non-denying fixture's
    /// root value stays below L. Default false.
    #[serde(default)]
    top_line_denies: bool,
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
    pub top_line_denies: bool,
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
        let spec_err = |e: SpecError| {
            let (field, reason) = e.field_and_reason();
            FixtureError::Invalid {
                id: id.clone(),
                field,
                reason,
            }
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

        // Tier A declares the gate or nothing. The live rules (slice-5 U10, B-proper) are the wire's and
        // Tier B's: their band is L', which the Tier A harness's L/2 band check does not read (review
        // round 5), and `roster` needs a P the fixture format does not carry.
        if file.feasibility.is_live() {
            return Err(invalid(
                "feasibility",
                format!(
                    "Tier A declares \"on\" or \"off\"; {:?} is a live rule (Tier B files and the wire), whose band the Tier A harness does not check",
                    file.feasibility
                ),
            ));
        }
        let five_picks =
            format.picks_per_side(Side::Blue) == 5 && format.picks_per_side(Side::Red) == 5;
        if file.feasibility != FeasibilityRule::Off && !five_picks {
            return Err(invalid(
                "feasibility",
                "\"on\" needs five picks a side (the predicate is defined only there); declare \"off\" and say why in notes".into(),
            ));
        }

        let universe =
            Universe::new(file.universe).map_err(|e| invalid("universe", e.to_string()))?;

        // Tier A pools are authored exactly: no board union (an off-pool pick is an authoring error).
        let entries = spec_to_entries(&file.position, &format, &universe).map_err(spec_err)?;
        let pools =
            spec_to_pools(&file.pools, &entries, &format, &universe, false).map_err(spec_err)?;
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
            let action = spec_to_action(e, root, &field, &universe).map_err(spec_err)?;
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
            top_line_denies: file.top_line_denies,
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

    /// The fixture's declared oracle on its own universe.
    pub fn evaluate(&self) -> Result<Evaluation, OracleError> {
        self.evaluate_with(&self.universe, self.mode)
    }

    /// Any objective, any mode — the invariant tests wrap the objective or vary the horizon.
    pub fn evaluate_with(
        &self,
        objective: &dyn Objective,
        mode: Mode,
    ) -> Result<Evaluation, OracleError> {
        let position = self.position();
        evaluate(&OracleInput {
            position: &position,
            universe: &self.universe,
            pools: &self.pools,
            objective,
            feasibility: self.feasibility,
            mode,
            epsilon: self.epsilon,
            off_pool_cost: None,
        })
    }
}
