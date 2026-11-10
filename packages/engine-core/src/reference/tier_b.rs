//! Tier B fixture files (slice-5 design § 6; target note D7): one real position per JSON, hand-
//! authored, with soft annotations and **no expected outputs**. Loaded against a caller-supplied
//! live universe; a data-version mismatch is a warning, never an error, because a Tier B position
//! is meant to be re-read against current data. Ids are strict here (a hand-authored file with a
//! typo should fail loudly); the live converter is the lenient one.

use super::entries::{
    pool_form, pool_set, role_key, spec_to_action, spec_to_entries, spec_to_pools, ActionSpec,
    EntrySpec, PoolForm, PoolsSpec, SpecError, ROLE_KEYS,
};
use super::feasibility::{FeasibilityMemo, FeasibilityRule, Price};
use super::format::{Format, Slot};
use super::live::{LiveError, LiveRoot, LiveUniverse};
use super::node::legal_actions_under;
use super::state::{Action, Entry, Pools, Position, PositionError};
use super::universe::{ChampionIdx, ChampionSet, Universe};
use crate::draft_state::{ActionType, Side};
use crate::feasibility::ROLES;
use crate::pools::Role;
use serde::{Deserialize, Deserializer};
use std::collections::{BTreeMap, HashMap};
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

/// The user's verdict on a GRADED top (engine-role-grade design § 6, adopted 2026-10-06): would they
/// play THIS action in THESE roles — `action` as `actual_next` is spelled, `roles` one role key per
/// champion of the action in the same order as written (`top`, `jungle`, `mid`, `adc`, `support`;
/// the loader re-pairs them to the action's canonical champion order), `ok` the answer. Read by the Q sweep alone: `ok: false` wants Q above every sampled Q at which the judged
/// action, in the judged roles, is the top; `ok: true` wants Q below them. A file's validity never
/// depends on the sweep: a verdict whose action is not a graded top at any sampled Q is warned and
/// skipped at read time, not refused here.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleVerdictSpec {
    pub action: ActionSpec,
    pub roles: Vec<String>,
    pub ok: bool,
}

/// `RoleVerdictSpec` resolved against the universe and the root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleVerdict {
    pub action: Action,
    pub roles: Vec<Role>,
    pub ok: bool,
}

/// The reader's judgement on one option (review-tool design § 1, Definitions): `play`, `maybe`,
/// `never`, for this team with these pools, ignoring P, Q and the engine's line.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Label {
    Play,
    Maybe,
    Never,
}

impl Label {
    pub const NAMES: [&'static str; 3] = ["play", "maybe", "never"];

    pub fn name(self) -> &'static str {
        match self {
            Label::Play => "play",
            Label::Maybe => "maybe",
            Label::Never => "never",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [Label::Play, Label::Maybe, Label::Never]
            .into_iter()
            .find(|l| l.name() == name)
    }
}

/// How an entry was written: `blind` before anything of the engine's was shown on the draft,
/// `scored` after (design § 1: blind means the draft had never been revealed).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VerdictMode {
    Blind,
    Scored,
}

impl VerdictMode {
    pub const NAMES: [&'static str; 2] = ["blind", "scored"];

    pub fn name(self) -> &'static str {
        match self {
            VerdictMode::Blind => "blind",
            VerdictMode::Scored => "scored",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [VerdictMode::Blind, VerdictMode::Scored]
            .into_iter()
            .find(|m| m.name() == name)
    }
}

/// An option (design Definitions): an action and, where role information exists, the mover's whole
/// side in the cheapest arrangement. `comp` is in `ROLES` order, `None` for a role the side has not
/// filled yet.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OptionKey {
    pub action: Action,
    pub comp: Option<[Option<ChampionIdx>; 5]>,
}

impl OptionKey {
    /// Reads an option id, e.g. `Renata+Ziggs|top=Camille,jungle=LeeSin,mid=Galio,adc=Ziggs,support=Renata`.
    /// The action's ids are sorted, the comp's roles in `ROLE_KEYS` order, and the comp's champions
    /// are exactly `mover_picks` (the mover's locked picks at `root`) plus the action, each once.
    pub fn parse(
        id: &str,
        root: Slot,
        mover_picks: &[ChampionIdx],
        universe: &Universe,
    ) -> Result<Self, SpecError> {
        Self::parse_at("option", id, root, mover_picks, universe)
    }

    /// `parse`, with the error's field named by the caller.
    fn parse_at(
        field: &str,
        id: &str,
        root: Slot,
        mover_picks: &[ChampionIdx],
        universe: &Universe,
    ) -> Result<Self, SpecError> {
        let bad = |reason: String| SpecError::Invalid {
            field: field.to_string(),
            reason,
        };
        let (left, right) = match id.split_once('|') {
            Some((left, right)) => (left, Some(right)),
            None => (id, None),
        };
        let names: Vec<&str> = left.split('+').collect();
        let spec = match names.as_slice() {
            [a] => ActionSpec::Single(a.to_string()),
            [a, b] => ActionSpec::Pair([a.to_string(), b.to_string()]),
            _ => {
                return Err(bad(format!(
                    "{left:?} is not one champion or two joined by '+'"
                )))
            }
        };
        let action = spec_to_action(&spec, root, field, universe)?;
        // Mover's picks plus the action, each once: the action cannot re-pick a locked champion.
        if let Some(c) = action.champions().find(|c| mover_picks.contains(c)) {
            return Err(bad(format!(
                "{} is already one of the side's locked picks; the action must add new champions",
                universe.id(c)
            )));
        }
        if let [a, b] = names.as_slice() {
            if a > b {
                return Err(bad(format!(
                    "the pair is not sorted by id: write {b}+{a}, the one spelling of an option"
                )));
            }
        }
        let Some(right) = right else {
            return Ok(OptionKey { action, comp: None });
        };
        if right.is_empty() {
            return Err(bad(
                "an empty comp after '|'; leave the '|' off to give the action alone".into(),
            ));
        }
        let mut comp = [None; 5];
        let mut last_role: Option<usize> = None;
        for part in right.split(',') {
            let (key, champion) = part
                .split_once('=')
                .ok_or_else(|| bad(format!("comp entry {part:?} is not role=champion")))?;
            let role = ROLE_KEYS.iter().position(|k| *k == key).ok_or_else(|| {
                bad(format!(
                    "unknown role key {key:?}; the keys are {}",
                    ROLE_KEYS.join(", ")
                ))
            })?;
            if last_role.is_some_and(|last| role <= last) {
                return Err(bad(format!(
                    "the comp's roles must be in the order {}, each once; {key:?} is out of place",
                    ROLE_KEYS.join(", ")
                )));
            }
            last_role = Some(role);
            let c = universe
                .index(champion)
                .ok_or_else(|| SpecError::UnknownChampion {
                    field: field.to_string(),
                    id: champion.to_string(),
                })?;
            comp[role] = Some(c);
        }
        let listed: Vec<ChampionIdx> = comp.iter().flatten().copied().collect();
        for (i, c) in listed.iter().enumerate() {
            if listed[..i].contains(c) {
                return Err(bad(format!("the comp lists {} twice", universe.id(*c))));
            }
        }
        for c in mover_picks {
            if !listed.contains(c) {
                return Err(bad(format!(
                    "the comp is missing {}, a pick the side has already locked",
                    universe.id(*c)
                )));
            }
        }
        for c in action.champions() {
            if !listed.contains(&c) {
                return Err(bad(format!(
                    "the comp is missing {}, a champion of the action",
                    universe.id(c)
                )));
            }
        }
        for c in &listed {
            if !mover_picks.contains(c) && !action.champions().any(|a| a == *c) {
                return Err(bad(format!(
                    "the comp has {}, who is neither a locked pick nor in the action",
                    universe.id(*c)
                )));
            }
        }
        Ok(OptionKey {
            action,
            comp: Some(comp),
        })
    }

    /// The option's one spelling: the action's ids sorted and joined with `+`, then `|` and the comp's
    /// `role=id` pairs in `ROLE_KEYS` order, when there is a comp.
    pub fn id(&self, universe: &Universe) -> String {
        let mut names: Vec<&str> = self.action.champions().map(|c| universe.id(c)).collect();
        names.sort_unstable();
        let mut id = names.join("+");
        if let Some(comp) = &self.comp {
            let roles: Vec<String> = ROLE_KEYS
                .iter()
                .zip(comp)
                .filter_map(|(key, c)| c.map(|c| format!("{key}={}", universe.id(c))))
                .collect();
            id.push('|');
            id.push_str(&roles.join(","));
        }
        id
    }
}

/// The page state that wrote an entry (design § 3b): the run's timestamp and the page's revision.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EntrySource {
    pub run: String,
    pub rev: u64,
}

/// The reader's verdict on the reference #1's line (design § 1): `ok` or not, keyed by the option
/// and the line's text. Never enters the rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineVerdict {
    pub option: OptionKey,
    pub line: String,
    pub ok: bool,
}

/// One appended sitting-slice of verdicts (design § 1). An entry holds only what it adds or changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerdictEntry {
    pub started: String,
    pub finished: String,
    pub mode: VerdictMode,
    pub from: EntrySource,
    pub fm_version: String,
    pub positions_patch: String,
    /// Outer `None`: not answered in this entry. `Some(None)`: answered "no view".
    pub would_pick: Option<Option<Action>>,
    pub labels: Vec<(OptionKey, Label)>,
    pub line: Option<LineVerdict>,
    pub note: Option<String>,
}

/// The two folds over a fixture's entries, in file order (design § 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedVerdicts {
    /// The last label written for each option in a `blind` entry.
    pub blind: HashMap<OptionKey, Label>,
    /// The last label written for each option, in any mode.
    pub current: HashMap<OptionKey, Label>,
    /// The own pick, folded the same two ways. Outer `None`: never answered.
    pub blind_pick: Option<Option<Action>>,
    pub current_pick: Option<Option<Action>>,
    /// Line verdicts: the last write for each (option, line), in the file order of that write.
    pub lines: Vec<LineVerdict>,
    /// Any entry is `scored`.
    pub revealed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LineVerdictSpec {
    option: String,
    line: serde_json::Value,
    ok: bool,
}

/// `would_pick`: absent is `None`, `null` is `Some(None)`, an action is `Some(Some(_))`.
fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<ActionSpec>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<ActionSpec>::deserialize(deserializer).map(Some)
}

/// The text fields stay raw values and `labels` stay strings here, so a bad one (a `null`
/// `positions_patch`, an array `line.line`, an unknown `mode`) is named by its field
/// (`verdicts[1].mode`), not by serde's position in the text. A missing field is serde's, which
/// names it.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerdictEntrySpec {
    started: serde_json::Value,
    finished: serde_json::Value,
    mode: serde_json::Value,
    from: EntrySource,
    fm_version: serde_json::Value,
    positions_patch: serde_json::Value,
    #[serde(default, deserialize_with = "double_option")]
    would_pick: Option<Option<ActionSpec>>,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    line: Option<LineVerdictSpec>,
    #[serde(default)]
    note: Option<String>,
}

/// `YYYY-MM-DDTHH:MM:SS[.f…]Z`: ISO-8601 UTC, the page's `toISOString` with or without the fraction.
fn is_utc_timestamp(s: &str) -> bool {
    let number = |part: Option<&str>, width: usize| -> Option<u32> {
        let part = part?;
        if part.len() == width && part.bytes().all(|b| b.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    let Some(body) = s.strip_suffix('Z') else {
        return false;
    };
    let (whole, fraction) = match body.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (body, None),
    };
    if fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let Some((date, time)) = whole.split_once('T') else {
        return false;
    };
    let mut date = date.split('-');
    let (Some(year), Some(month), Some(day), None) = (
        number(date.next(), 4),
        number(date.next(), 2),
        number(date.next(), 2),
        date.next(),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    let mut time = time.split(':');
    let (Some(hour), Some(minute), Some(second), None) = (
        number(time.next(), 2),
        number(time.next(), 2),
        number(time.next(), 2),
        time.next(),
    ) else {
        return false;
    };
    (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

/// Resolves a file's `verdicts` against the root: every id through `OptionKey`, every action through
/// `spec_to_action`, each mistake named by its field.
fn resolve_verdicts(
    id: &str,
    specs: &[VerdictEntrySpec],
    root: Slot,
    mover_picks: &[ChampionIdx],
    universe: &Universe,
) -> Result<Vec<VerdictEntry>, TierBError> {
    let invalid = |field: String, reason: String| TierBError::Invalid {
        id: id.to_string(),
        field,
        reason,
    };
    let spec_err = |e: SpecError| {
        let (field, reason) = e.field_and_reason();
        TierBError::Invalid {
            id: id.to_string(),
            field,
            reason,
        }
    };
    let text = |field: String, value: &serde_json::Value| -> Result<String, TierBError> {
        value
            .as_str()
            .map(String::from)
            .ok_or_else(|| invalid(field, format!("must be a string, got {value}")))
    };
    let mut revealed = false;
    let mut entries = Vec::with_capacity(specs.len());
    for (i, spec) in specs.iter().enumerate() {
        let at = |name: &str| format!("verdicts[{i}].{name}");
        let started = text(at("started"), &spec.started)?;
        let finished = text(at("finished"), &spec.finished)?;
        for (name, value) in [("started", &started), ("finished", &finished)] {
            if !is_utc_timestamp(value) {
                return Err(invalid(
                    at(name),
                    format!("{value:?} is not an ISO-8601 UTC timestamp like 2026-11-09T14:10:05Z"),
                ));
            }
        }
        let mode_name = text(at("mode"), &spec.mode)?;
        let mode = VerdictMode::from_name(&mode_name).ok_or_else(|| {
            invalid(
                at("mode"),
                format!(
                    "unknown mode {mode_name:?}; the modes are {}",
                    VerdictMode::NAMES.join(", ")
                ),
            )
        })?;
        let fm_version = text(at("fm_version"), &spec.fm_version)?;
        let positions_patch = text(at("positions_patch"), &spec.positions_patch)?;
        // Blind means the draft had never been revealed: after a scored entry, the file is wrong.
        if mode == VerdictMode::Blind && revealed {
            return Err(invalid(
                at("mode"),
                "a blind entry after a scored one; once a position has been revealed every later label is scored"
                    .into(),
            ));
        }
        revealed |= mode == VerdictMode::Scored;
        let would_pick = match &spec.would_pick {
            None => None,
            Some(None) => Some(None),
            Some(Some(action)) => Some(Some(
                spec_to_action(action, root, &at("would_pick"), universe).map_err(spec_err)?,
            )),
        };
        let mut labels = Vec::with_capacity(spec.labels.len());
        for (option, name) in &spec.labels {
            let field = at(&format!("labels[{option}]"));
            let key = OptionKey::parse_at(&field, option, root, mover_picks, universe)
                .map_err(spec_err)?;
            let label = Label::from_name(name).ok_or_else(|| {
                invalid(
                    field,
                    format!(
                        "unknown label {name:?}; the labels are {}",
                        Label::NAMES.join(", ")
                    ),
                )
            })?;
            labels.push((key, label));
        }
        let line = match &spec.line {
            None => None,
            // The engine's line is shown only at reveal: a blind entry cannot judge it.
            Some(_) if mode == VerdictMode::Blind => {
                return Err(invalid(
                    at("line"),
                    "a line verdict in a blind entry; the line is shown only at reveal".into(),
                ));
            }
            Some(line) => Some(LineVerdict {
                option: OptionKey::parse_at(
                    &at("line.option"),
                    &line.option,
                    root,
                    mover_picks,
                    universe,
                )
                .map_err(spec_err)?,
                line: text(at("line.line"), &line.line)?,
                ok: line.ok,
            }),
        };
        entries.push(VerdictEntry {
            started,
            finished,
            mode,
            from: spec.from.clone(),
            fm_version,
            positions_patch,
            would_pick,
            labels,
            line,
            note: spec.note.clone(),
        });
    }
    Ok(entries)
}

/// Why `action` is not among the legal actions: the champion's state on the board.
fn why_illegal(action: Action, on_board: ChampionSet, excluded: ChampionSet) -> &'static str {
    if action.champions().any(|c| on_board.contains(c)) {
        "already on the board"
    } else if action.champions().any(|c| excluded.contains(c)) {
        "excluded"
    } else {
        "not generated at this root"
    }
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
    #[serde(default)]
    role_verdict: Option<RoleVerdictSpec>,
    /// Graded verdicts, appended and never rewritten (review-tool design § 1).
    #[serde(default)]
    verdicts: Vec<VerdictEntrySpec>,
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
    /// Engine-role-grade § 6: the verdict on a graded top, when the user has given one.
    pub role_verdict: Option<RoleVerdict>,
    /// Review-tool design § 1: the graded verdict history, in file order; fold with `resolved`.
    /// Empty at a ban root, where it is not read.
    pub verdicts: Vec<VerdictEntry>,
    /// The file's `verdicts` entries exactly as written, all of them, also at a ban root where
    /// `verdicts` is empty: what the run JSON echoes, and what `base` counts (apply's staleness check).
    pub verdicts_raw: Vec<serde_json::Value>,
    /// The file's `pools` as written (list or role map, authored order), `None` where absent: what the
    /// run JSON echoes. `root.pools` is the resolved form.
    pub pools_raw: Option<serde_json::Value>,
    pub capture: Option<serde_json::Value>,
    pub path: Option<PathBuf>,
}

/// A second, lenient read of the file for its `verdicts` and `pools`, kept as written.
#[derive(Deserialize)]
struct RawFields {
    #[serde(default)]
    verdicts: Vec<serde_json::Value>,
    #[serde(default)]
    pools: Option<serde_json::Value>,
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
    /// The two folds over `verdicts`, in file order (design § 1). Current is the last label written
    /// for each option in any mode; blind is the last written in a `blind` entry, so a `scored` entry
    /// never changes it. The own pick folds the same way, and an entry without `would_pick` leaves it
    /// alone while `would_pick: null` ("no view") replaces it.
    pub fn resolved(&self) -> ResolvedVerdicts {
        let mut resolved = ResolvedVerdicts {
            blind: HashMap::new(),
            current: HashMap::new(),
            blind_pick: None,
            current_pick: None,
            lines: Vec::new(),
            revealed: false,
        };
        for entry in &self.verdicts {
            let blind = entry.mode == VerdictMode::Blind;
            resolved.revealed |= !blind;
            for (option, label) in &entry.labels {
                resolved.current.insert(option.clone(), *label);
                if blind {
                    resolved.blind.insert(option.clone(), *label);
                }
            }
            if let Some(pick) = entry.would_pick {
                resolved.current_pick = Some(pick);
                if blind {
                    resolved.blind_pick = Some(pick);
                }
            }
            if let Some(line) = &entry.line {
                resolved
                    .lines
                    .retain(|l| !(l.option == line.option && l.line == line.line));
                resolved.lines.push(line.clone());
            }
        }
        resolved
    }

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
        let RawFields {
            verdicts: verdicts_raw,
            pools: pools_raw,
        } = serde_json::from_str::<RawFields>(raw).map_err(|source| TierBError::Json {
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
        let role_verdict = match &file.role_verdict {
            None => None,
            Some(spec) => {
                let action = spec_to_action(&spec.action, root, "role_verdict.action", universe)
                    .map_err(spec_err)?;
                let roles = spec
                    .roles
                    .iter()
                    .map(|key| {
                        ROLE_KEYS
                            .iter()
                            .position(|k| k == key)
                            .map(|i| ROLES[i])
                            .ok_or_else(|| {
                                invalid(
                                    "role_verdict.roles",
                                    format!(
                                        "unknown role key {key:?}; the keys are {}",
                                        ROLE_KEYS.join(", ")
                                    ),
                                )
                            })
                    })
                    .collect::<Result<Vec<Role>, TierBError>>()?;
                let champions = action.champions().count();
                if roles.len() != champions {
                    return Err(invalid(
                        "role_verdict.roles",
                        format!(
                            "{} role(s) for an action of {champions} champion(s); one role per champion, in the action's order",
                            roles.len()
                        ),
                    ));
                }
                // The spec's order is the spec's champion order; `Action::pair` keeps a pair by
                // index, so the roles are re-paired to `action.champions()`'s order — what the
                // report's trace yields.
                let spec_order: Vec<ChampionIdx> = match &spec.action {
                    ActionSpec::Single(id) => vec![universe.index(id).expect("resolved above")],
                    ActionSpec::Pair([a, b]) => vec![
                        universe.index(a).expect("resolved above"),
                        universe.index(b).expect("resolved above"),
                    ],
                };
                let mut paired: Vec<(ChampionIdx, Role)> =
                    spec_order.into_iter().zip(roles).collect();
                paired.sort_by_key(|(c, _)| *c);
                Some(RoleVerdict {
                    action,
                    roles: paired.into_iter().map(|(_, r)| r).collect(),
                    ok: spec.ok,
                })
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
                let why = why_illegal(action, on_board, excluded);
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
        if role_verdict.is_some() && root.action == ActionType::Ban {
            warnings.push(format!(
                "{id}: role_verdict: no role question at a ban root; the report skips it"
            ));
        }
        // The graded verdicts. At a ban root there is no option to judge: warned, not read (a ban
        // inside the horizon ties on the board, review design D3 iii).
        let verdicts = if file.verdicts.is_empty() {
            Vec::new()
        } else if root.action == ActionType::Ban {
            warnings.push(format!(
                "{id}: verdicts: no options to judge at a ban root; not read"
            ));
            Vec::new()
        } else {
            let mover_picks = position.picks(root.side);
            let entries = resolve_verdicts(&id, &file.verdicts, root, mover_picks, universe)?;
            // An own pick the reference would never generate is still what the reader said.
            let mut legal = None;
            for (i, entry) in entries.iter().enumerate() {
                let Some(Some(action)) = entry.would_pick else {
                    continue;
                };
                let legal = legal.get_or_insert_with(|| {
                    legal_actions_under(
                        &position,
                        universe,
                        &pools,
                        FeasibilityRule::Roster,
                        &mut FeasibilityMemo::new(Price::ZERO),
                    )
                });
                if !legal.contains(&action) {
                    let names: Vec<&str> = action.champions().map(|c| universe.id(c)).collect();
                    warnings.push(format!(
                        "{id}: verdicts[{i}].would_pick {} is not a legal action here ({})",
                        names.join("+"),
                        why_illegal(action, on_board, excluded)
                    ));
                }
            }
            entries
        };
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
                role_verdict,
                verdicts,
                verdicts_raw,
                pools_raw,
                capture: file.capture,
                path: None,
            },
            warnings,
            notes,
        })
    }
}
