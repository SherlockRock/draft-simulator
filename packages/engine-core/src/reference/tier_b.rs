//! Tier B fixture files (slice-5 design § 6; target note D7): one real position per JSON, hand-
//! authored, with soft annotations and **no expected outputs**. Loaded against a caller-supplied
//! live universe; a data-version mismatch is a warning, never an error, because a Tier B position
//! is meant to be re-read against current data. Ids are strict here (a hand-authored file with a
//! typo should fail loudly); the live converter is the lenient one.

use super::entries::{
    pool_form, pool_set, role_key, spec_to_action, spec_to_entries, spec_to_pools, ActionSpec,
    EntrySpec, PoolForm, PoolsSpec,
};
use super::feasibility::{FeasibilityMemo, FeasibilityRule, Price};
use super::format::Format;
use super::live::{LiveError, LiveRoot, LiveUniverse};
use super::node::legal_actions_under;
use super::state::{Action, Entry, Pools, Position, PositionError};
use super::universe::ChampionSet;
use crate::draft_state::{ActionType, Side};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// D7's tags, plus B-proper's calibration subset.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    ProReplay,
    CounterPick,
    FlexRetention,
    PairCoherence,
    EdgeCase,
    /// A position where an off-pool pick tempts: the calibration subset for P (B-proper § 3).
    OffPool,
}

/// The user's structured verdict on a position (B-proper § 3): would they leave the pool here. Each
/// verdict is an interval constraint on P that the report intersects — `true`: P must sit below the
/// smallest sweep P at which the top action is in-pool; `false`: above the largest at which it is
/// off-pool. Free-text `review` stays beside it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Verdict {
    pub off_pool: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub fm_version: String,
    pub meta_version: String,
    pub captured: String,
    #[serde(default)]
    pub session: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TierBFile {
    id: String,
    category: Category,
    notes: String,
    source: Source,
    format: String,
    position: Vec<EntrySpec>,
    /// Absent (a pro replay, D7: "no pools") = the whole roster on both sides. Each side is a list of
    /// ids or the app's role map `{top, jungle, mid, adc, support}` (`entries::pool_form`).
    #[serde(default)]
    pools: Option<PoolsSpec>,
    #[serde(default)]
    exclusions: Vec<String>,
    #[serde(default)]
    our_side: Option<Side>,
    #[serde(default)]
    actual_next: Option<ActionSpec>,
    #[serde(default)]
    review: String,
    #[serde(default)]
    verdict: Option<Verdict>,
    /// The raw captured request (the wire `EngineRequest`, when the capture button exists), kept
    /// opaque so nothing the loader does not model (display pools, tiers) is lost. Must be an object
    /// with a string `protocolVersion`; the top-level fields win when the two disagree (warned).
    #[serde(default)]
    capture: Option<serde_json::Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum TierBError {
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
    #[error(transparent)]
    Live(#[from] LiveError),
}

#[derive(Clone, Debug)]
pub struct TierBFixture {
    pub id: String,
    pub category: Category,
    pub notes: String,
    pub source: Source,
    pub root: LiveRoot,
    /// The side the rubric is read from, when the capture knows it.
    pub our_side: Option<Side>,
    /// The soft comparison point (D7): what was actually played next. Never truth.
    pub actual_next: Option<Action>,
    pub review: String,
    /// B-proper § 3: the calibration verdict, when the user has given one.
    pub verdict: Option<Verdict>,
    pub capture: Option<serde_json::Value>,
    pub path: Option<PathBuf>,
}

/// A loaded fixture plus the non-fatal findings (data-version mismatches, an illegal `actual_next`)
/// and the notes — facts about the file a reader of the report should see that are not mistakes: a
/// pool entry under a role the meta does not list (role-aware pools RA4: honoured, playable for that
/// side only).
#[derive(Clone, Debug)]
pub struct Loaded {
    pub fixture: TierBFixture,
    pub warnings: Vec<String>,
    pub notes: Vec<String>,
}

impl TierBFixture {
    pub fn load_file(path: &Path, live: &LiveUniverse) -> Result<Loaded, TierBError> {
        let raw = std::fs::read_to_string(path).map_err(|source| TierBError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let mut loaded = Self::from_json(&raw, &path.display().to_string(), live)?;
        loaded.fixture.path = Some(path.to_path_buf());
        Ok(loaded)
    }

    /// Every `*.json` in `dir`, sorted by file name, each with its own result: one malformed file is
    /// reported in its place and the rest still load (B-proper § 3 — a report run must not stop on
    /// one bad file). The outer error is the directory's.
    pub fn load_dir(
        dir: &Path,
        live: &LiveUniverse,
    ) -> Result<Vec<Result<Loaded, TierBError>>, TierBError> {
        let entries = std::fs::read_dir(dir).map_err(|source| TierBError::Io {
            path: dir.to_path_buf(),
            source,
        })?;
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
            .collect();
        paths.sort();
        Ok(paths.iter().map(|p| Self::load_file(p, live)).collect())
    }

    pub fn from_json(raw: &str, label: &str, live: &LiveUniverse) -> Result<Loaded, TierBError> {
        let file: TierBFile = serde_json::from_str(raw).map_err(|source| TierBError::Json {
            label: label.to_string(),
            source,
        })?;
        let id = file.id.clone();
        let invalid = |field: &str, reason: String| TierBError::Invalid {
            id: id.clone(),
            field: field.to_string(),
            reason,
        };
        let spec_err = |e: super::entries::SpecError| {
            let (field, reason) = e.field_and_reason();
            TierBError::Invalid {
                id: id.clone(),
                field,
                reason,
            }
        };

        if file.format != "standard" {
            return Err(invalid(
                "format",
                format!(
                    "unknown format {:?}; only \"standard\" is supported",
                    file.format
                ),
            ));
        }
        let format = Format::standard();
        let universe = &live.universe;
        let entries = spec_to_entries(&file.position, &format, universe).map_err(spec_err)?;
        let pools = match &file.pools {
            Some(spec) => {
                spec_to_pools(spec, &entries, &format, universe, true).map_err(spec_err)?
            }
            None => Pools {
                blue: universe.all(),
                red: universe.all(),
                ..Pools::default()
            },
        };
        let mut notes = Vec::new();
        for (side, name) in [(Side::Blue, "blue"), (Side::Red, "red")] {
            for (role, c) in pools
                .roles(side)
                .map(|tags| tags.off_meta(universe))
                .unwrap_or_default()
            {
                let key = role_key(role);
                notes.push(format!(
                    "{id}: pools.{name}.{key}: {} is not a meta {key} — playable for {side:?} only",
                    universe.id(c)
                ));
            }
        }
        let excluded = pool_set("exclusions", &file.exclusions, universe).map_err(spec_err)?;
        if let Some(capture) = &file.capture {
            let version = capture
                .as_object()
                .and_then(|o| o.get("protocolVersion"))
                .and_then(|v| v.as_str());
            if version.is_none() {
                return Err(invalid(
                    "capture",
                    "must be an object with a string protocolVersion (a captured wire request)"
                        .into(),
                ));
            }
        }
        let position = Position::new(&format, &entries, &pools, universe)
            .map_err(|e: PositionError| invalid("position", e.to_string()))?
            .with_excluded(excluded);
        let root = position.next_slot().ok_or_else(|| {
            invalid(
                "position",
                "the draft is complete; nothing to evaluate".into(),
            )
        })?;
        let actual_next = match &file.actual_next {
            None => None,
            Some(spec) => {
                Some(spec_to_action(spec, root, "actual_next", universe).map_err(spec_err)?)
            }
        };

        let mut warnings = Vec::new();
        if file.source.fm_version != live.fm_version {
            warnings.push(format!(
                "{id}: captured on FM {} but loaded against {}",
                file.source.fm_version, live.fm_version
            ));
        }
        if file.source.meta_version != live.meta_version {
            warnings.push(format!(
                "{id}: captured on champion-meta {} but loaded against {}",
                file.source.meta_version, live.meta_version
            ));
        }
        // The board proper (bans and picks in `entries`), as distinct from `taken`, which also holds
        // the exclusions after `with_excluded`.
        let on_board: ChampionSet = entries
            .iter()
            .filter_map(|e| match e {
                Entry::Ban(c) | Entry::Pick(c) => Some(*c),
                Entry::Skip => None,
            })
            .collect();
        let overlap = excluded.intersect(on_board);
        if !overlap.is_empty() {
            warnings.push(format!(
                "{id}: exclusions name champions already on the board: {}",
                universe.names_of(overlap).join(", ")
            ));
        }
        // An `actual_next` the reference would never generate is still recorded (it is what was
        // played), but the reader should know the rank it prints is against a list that lacks it.
        if let Some(action) = actual_next {
            // Legality under `roster` (B-proper), the widest rule the report searches with: every
            // available champion is a pick, so only a champion on the board or excluded fails here
            // (an off-pool `actual_next` is legal, and the report says whether it was in the pool).
            // Legality reads the unweighted profile only: an unpriced memo is right here.
            let legal = legal_actions_under(
                &position,
                universe,
                &pools,
                FeasibilityRule::Roster,
                &mut FeasibilityMemo::new(Price::ZERO),
            );
            if !legal.contains(&action) {
                let names: Vec<&str> = action.champions().map(|c| universe.id(c)).collect();
                let why = if action.champions().any(|c| on_board.contains(c)) {
                    "already on the board"
                } else if action.champions().any(|c| excluded.contains(c)) {
                    "excluded"
                } else {
                    "not generated at this root"
                };
                warnings.push(format!(
                    "{id}: actual_next {} is not a legal action here ({why})",
                    names.join("+")
                ));
            }
        }
        // A verdict answers "would you leave the pool here": at a ban root there is no such question.
        if file.verdict.is_some() && root.action == ActionType::Ban {
            warnings.push(format!(
                "{id}: verdict: no off-pool question at a ban root; the report counts it as unusable"
            ));
        }
        // `capture` is provenance; the top-level fields are the position. Say so when they disagree.
        if let Some(capture) = &file.capture {
            let list = |path: &[&str]| -> Option<Vec<String>> {
                let mut v = capture;
                for key in path {
                    v = v.get(key)?;
                }
                v.as_array().map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
            };
            let differs = |captured: Option<Vec<String>>, declared: &[String]| -> bool {
                captured.is_some_and(|mut c| {
                    let mut d = declared.to_vec();
                    c.sort();
                    d.sort();
                    c != d
                })
            };
            // A list side is compared with the capture's `search` list; a role-map side with its
            // `display` map, role by role (the wire's keys). Absent pools compare as empty lists.
            const DISPLAY_KEYS: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"];
            let side_differs = |name: &str, field: &str, value: Option<&serde_json::Value>| {
                match value.map(|v| pool_form(field, v)) {
                    None => differs(list(&["pools", name, "search"]), &[]),
                    Some(Ok(PoolForm::List(ids))) => {
                        differs(list(&["pools", name, "search"]), &ids)
                    }
                    Some(Ok(PoolForm::Roles(rows))) => DISPLAY_KEYS
                        .iter()
                        .zip(&rows)
                        .any(|(key, ids)| differs(list(&["pools", name, "display", key]), ids)),
                    // Unreachable: `spec_to_pools` read the same value above.
                    Some(Err(_)) => false,
                }
            };
            let sides = file.pools.as_ref();
            for (what, differs) in [
                (
                    "pools.blue",
                    side_differs("blue", "pools.blue", sides.map(|p| &p.blue)),
                ),
                (
                    "pools.red",
                    side_differs("red", "pools.red", sides.map(|p| &p.red)),
                ),
                (
                    "exclusions",
                    differs(list(&["pools", "crossGameExclusions"]), &file.exclusions),
                ),
            ] {
                if differs {
                    warnings.push(format!(
                        "{id}: {what} differs from the captured request; the top-level field is used"
                    ));
                }
            }
        }
        drop(position);

        Ok(Loaded {
            fixture: TierBFixture {
                id: file.id,
                category: file.category,
                notes: file.notes,
                source: file.source,
                root: LiveRoot {
                    format,
                    entries,
                    pools,
                    excluded,
                    unknown: Vec::new(),
                },
                our_side: file.our_side,
                actual_next,
                review: file.review,
                verdict: file.verdict,
                capture: file.capture,
                path: None,
            },
            warnings,
            notes,
        })
    }
}
