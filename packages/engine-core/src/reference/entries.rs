//! Slot-entry, pool and action specs shared by the Tier A loader (`fixture`), the live converter
//! (`live`) and the Tier B loader (`tier_b`) — one validation path (slice-5 design § 6, U7).
//! Every error names its field so a mis-authored file fails with a location, never a wrong answer.

use super::format::{Format, Slot};
use super::state::{Action, Entry, Pools};
use super::universe::{ChampionSet, Universe};
use crate::draft_state::{ActionType, Side};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Ban,
    Pick,
    Skip,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntrySpec {
    pub slot: usize,
    pub side: Side,
    pub kind: EntryKind,
    #[serde(default)]
    pub champion: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PoolsSpec {
    pub blue: Vec<String>,
    pub red: Vec<String>,
}

/// A single id at a single slot, `[a, b]` at a pair start (Tier A `expected_top`, Tier B `actual_next`).
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum ActionSpec {
    Single(String),
    Pair([String; 2]),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SpecError {
    #[error("{field}: unknown champion {id:?}")]
    UnknownChampion { field: String, id: String },
    #[error("{field}: {reason}")]
    Invalid { field: String, reason: String },
}

impl SpecError {
    /// The loaders' `Invalid { id, field, reason }` shape: the field and the reason text.
    pub fn field_and_reason(self) -> (String, String) {
        match self {
            SpecError::UnknownChampion { field, id } => (field, format!("unknown champion {id:?}")),
            SpecError::Invalid { field, reason } => (field, reason),
        }
    }
}

fn lookup(
    field: &str,
    id: &str,
    universe: &Universe,
) -> Result<super::universe::ChampionIdx, SpecError> {
    universe
        .index(id)
        .ok_or_else(|| SpecError::UnknownChampion {
            field: field.to_string(),
            id: id.to_string(),
        })
}

/// Slot index = list index; side and kind must match the format's slot (a `skip` only on a ban
/// slot); ids resolve against the universe. Duplicate / pool checks are `Position::new`'s.
pub fn spec_to_entries(
    specs: &[EntrySpec],
    format: &Format,
    universe: &Universe,
) -> Result<Vec<Entry>, SpecError> {
    let mut entries = Vec::with_capacity(specs.len());
    for (i, e) in specs.iter().enumerate() {
        let field = |suffix: &str| format!("position[{i}].{suffix}");
        let invalid = |suffix: &str, reason: String| SpecError::Invalid {
            field: field(suffix),
            reason,
        };
        if e.slot != i {
            return Err(invalid("slot", format!("slot {} at index {i}", e.slot)));
        }
        let slot = format
            .slot(i)
            .ok_or_else(|| invalid("slot", "beyond the format".into()))?;
        if e.side != slot.side {
            return Err(invalid(
                "side",
                format!("the format's slot {i} belongs to {:?}", slot.side),
            ));
        }
        let expected_kind = match slot.action {
            ActionType::Ban => EntryKind::Ban,
            ActionType::Pick => EntryKind::Pick,
        };
        if e.kind != expected_kind && !(e.kind == EntryKind::Skip && slot.action == ActionType::Ban)
        {
            return Err(invalid(
                "kind",
                format!("the format's slot {i} is a {:?}", slot.action),
            ));
        }
        let entry = match (e.kind, &e.champion) {
            (EntryKind::Skip, None) => Entry::Skip,
            (EntryKind::Skip, Some(_)) => {
                return Err(invalid("champion", "a skip names no champion".into()))
            }
            (_, None) => return Err(invalid("champion", "missing".into())),
            (EntryKind::Ban, Some(id)) => Entry::Ban(lookup(&field("champion"), id, universe)?),
            (EntryKind::Pick, Some(id)) => Entry::Pick(lookup(&field("champion"), id, universe)?),
        };
        entries.push(entry);
    }
    Ok(entries)
}

/// Ids → set, unknown ids collected instead of refused (the live path, slice-5 U5: the wire must not
/// refuse a compute over a stale pool id — the caller reports them).
pub fn pool_set_lenient(ids: &[String], universe: &Universe) -> (ChampionSet, Vec<String>) {
    let mut set = ChampionSet::EMPTY;
    let mut unknown = Vec::new();
    for id in ids {
        match universe.index(id) {
            Some(c) => set = set.with(c),
            None => unknown.push(id.clone()),
        }
    }
    (set, unknown)
}

/// Ids → set; `field` names the list in errors (`pools.blue`).
pub fn pool_set(
    field: &str,
    ids: &[String],
    universe: &Universe,
) -> Result<ChampionSet, SpecError> {
    let mut set = ChampionSet::EMPTY;
    for id in ids {
        set = set.with(lookup(field, id, universe)?);
    }
    Ok(set)
}

/// The `Pick` entries that belong to `side`, read off the format's slots.
pub fn board_picks(entries: &[Entry], format: &Format, side: Side) -> ChampionSet {
    entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match (e, format.slot(i)) {
            (Entry::Pick(c), Some(slot)) if slot.side == side => Some(*c),
            _ => None,
        })
        .collect()
}

/// Both pools as sets. `union_board = true` (live, Tier B — slice-5 U5) adds each side's own picks
/// already on the board, so a past off-pool pick loads as a fact; `false` (Tier A) keeps the authored
/// set exactly, so an off-pool pick stays a `PickOutsidePool` authoring error.
pub fn spec_to_pools(
    spec: &PoolsSpec,
    entries: &[Entry],
    format: &Format,
    universe: &Universe,
    union_board: bool,
) -> Result<Pools, SpecError> {
    let mut pools = Pools {
        blue: pool_set("pools.blue", &spec.blue, universe)?,
        red: pool_set("pools.red", &spec.red, universe)?,
        ..Pools::default()
    };
    if union_board {
        pools.blue = pools.blue.union(board_picks(entries, format, Side::Blue));
        pools.red = pools.red.union(board_picks(entries, format, Side::Red));
    }
    Ok(pools)
}

/// Resolves an action spec at `root`: a single id at a ban or single-pick slot, a pair at a pair start.
pub fn spec_to_action(
    spec: &ActionSpec,
    root: Slot,
    field: &str,
    universe: &Universe,
) -> Result<Action, SpecError> {
    let invalid = |reason: &str| SpecError::Invalid {
        field: field.to_string(),
        reason: reason.to_string(),
    };
    match spec {
        ActionSpec::Single(id) => {
            let c = lookup(field, id, universe)?;
            match root.action {
                ActionType::Ban => Ok(Action::Ban(c)),
                ActionType::Pick if !root.pair_start => Ok(Action::Pick(c)),
                ActionType::Pick => Err(invalid(
                    "the root is a pair turn; expected actions are [a, b] pairs",
                )),
            }
        }
        ActionSpec::Pair([a, b]) => {
            if !root.pair_start {
                return Err(invalid(
                    "the root is not a pair turn; expected actions are single ids",
                ));
            }
            let (a, b) = (lookup(field, a, universe)?, lookup(field, b, universe)?);
            if a == b {
                return Err(invalid("a pair of the same champion"));
            }
            Ok(Action::pair(a, b))
        }
    }
}
