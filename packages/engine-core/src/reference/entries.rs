//! Slot-entry, pool and action specs shared by the Tier A loader (`fixture`), the live converter
//! (`live`) and the Tier B loader (`tier_b`) — one validation path (slice-5 design § 6, U7).
//! Every error names its field so a mis-authored file fails with a location, never a wrong answer.

use super::format::{Format, Slot};
use super::state::{Action, Entry, Pools, RoleSets};
use super::universe::{ChampionIdx, ChampionSet, Universe};
use crate::draft_state::{ActionType, Side};
use crate::feasibility::ROLES;
use crate::pools::Role;
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

/// Each side is kept as raw JSON and read by `pool_form`, field by field: a side is a list of ids
/// or a role map, and an untagged serde enum would report a mistake in either as "did not match any
/// variant" with no location.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PoolsSpec {
    pub blue: serde_json::Value,
    pub red: serde_json::Value,
}

/// The role map's keys, in `crate::feasibility::ROLES` order: the app's spelling (`Pools.champions`),
/// so `mid` and `adc` — not the crate's `middle` nor the meta's `BOTTOM`. Spelled once, in `role_key`.
pub const ROLE_KEYS: [&str; 5] = [
    role_key(ROLES[0]),
    role_key(ROLES[1]),
    role_key(ROLES[2]),
    role_key(ROLES[3]),
    role_key(ROLES[4]),
];

/// `role`'s key in a role map — the one spelling `ROLE_KEYS` is built from.
pub const fn role_key(role: Role) -> &'static str {
    match role {
        Role::Top => "top",
        Role::Jungle => "jungle",
        Role::Middle => "mid",
        Role::Adc => "adc",
        Role::Support => "support",
    }
}

/// One side's pool as authored (role-aware pools design § 4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PoolForm {
    /// A list of ids: every role the meta lists for each (today's form).
    List(Vec<String>),
    /// The app's role map: the ids listed under each of `ROLE_KEYS`, in that order.
    Roles([Vec<String>; 5]),
}

/// Reads one side of `pools` (`field` = `pools.blue` / `pools.red`): a list of ids, or a map with
/// exactly the five `ROLE_KEYS`, each a list of ids (empty allowed; a champion may sit under several).
/// Every mistake is named with its location.
pub fn pool_form(field: &str, value: &serde_json::Value) -> Result<PoolForm, SpecError> {
    let invalid = |field: String, reason: String| SpecError::Invalid { field, reason };
    let ids = |field: &str, value: &serde_json::Value| -> Result<Vec<String>, SpecError> {
        let list = value
            .as_array()
            .ok_or_else(|| invalid(field.to_string(), "expected a list of champion ids".into()))?;
        list.iter()
            .enumerate()
            .map(|(i, id)| {
                id.as_str().map(String::from).ok_or_else(|| {
                    invalid(format!("{field}[{i}]"), "expected a champion id".into())
                })
            })
            .collect()
    };
    if value.is_array() {
        return ids(field, value).map(PoolForm::List);
    }
    let Some(map) = value.as_object() else {
        return Err(invalid(
            field.to_string(),
            "expected a list of champion ids or a role map {top, jungle, mid, adc, support}".into(),
        ));
    };
    if let Some(key) = map.keys().find(|k| !ROLE_KEYS.contains(&k.as_str())) {
        return Err(invalid(
            format!("{field}.{key}"),
            "unknown role; a role map has exactly top, jungle, mid, adc, support".into(),
        ));
    }
    let mut rows: [Vec<String>; 5] = Default::default();
    for (row, key) in rows.iter_mut().zip(ROLE_KEYS) {
        let role_field = format!("{field}.{key}");
        let listed = map.get(key).ok_or_else(|| {
            invalid(
                role_field.clone(),
                "missing; a role map has exactly top, jungle, mid, adc, support".into(),
            )
        })?;
        *row = ids(&role_field, listed)?;
    }
    Ok(PoolForm::Roles(rows))
}

/// Tier A takes list form only (D4: the gate rules have no price for an off-role pick; role tags are
/// the live rules'). A map is refused by shape, before it is read, so a malformed one gets this
/// message too.
pub fn refuse_role_maps(spec: &PoolsSpec) -> Result<(), SpecError> {
    for (field, value) in [("pools.blue", &spec.blue), ("pools.red", &spec.red)] {
        if value.is_object() {
            return Err(SpecError::Invalid {
                field: field.to_string(),
                reason: "a role map in a Tier A fixture: Tier A pools gate as sets (D4) and take list form; role tags are priced by the live rules"
                    .to_string(),
            });
        }
    }
    Ok(())
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

/// Both pools. A list side is a set, as before; a role-map side carries its tags (role-aware pools
/// design § 1, § 4). `union_board = true` (live, Tier B — slice-5 U5) adds each side's own picks
/// already on the board, so a past off-pool pick loads as a fact; `false` (Tier A) keeps the authored
/// set exactly, so an off-pool pick stays a `PickOutsidePool` authoring error.
pub fn spec_to_pools(
    spec: &PoolsSpec,
    entries: &[Entry],
    format: &Format,
    universe: &Universe,
    union_board: bool,
) -> Result<Pools, SpecError> {
    let mut pools = Pools::default();
    for (side, field, value) in [
        (Side::Blue, "pools.blue", &spec.blue),
        (Side::Red, "pools.red", &spec.red),
    ] {
        let board = if union_board {
            board_picks(entries, format, side)
        } else {
            ChampionSet::EMPTY
        };
        pools = match pool_form(field, value)? {
            PoolForm::List(ids) => {
                let set = pool_set(field, &ids, universe)?.union(board);
                match side {
                    Side::Blue => Pools { blue: set, ..pools },
                    Side::Red => Pools { red: set, ..pools },
                }
            }
            PoolForm::Roles(rows) => {
                let mut tags = RoleSets::default();
                for ((role, key), ids) in ROLES.iter().zip(ROLE_KEYS).zip(&rows) {
                    for id in ids {
                        tags = tags.with(*role, lookup(&format!("{field}.{key}"), id, universe)?);
                    }
                }
                pools.with_roles(side, with_board_picks(tags, board, universe))
            }
        };
    }
    Ok(pools)
}

/// A role-tagged side's own board picks (design, Definitions): one the pool lists keeps its listed
/// roles — so a later pick that displaces it is charged (RA2) — and one the pool omits is added under
/// every meta role: a sunk fact, never off-role, never charged. A pick with no meta role would have
/// none to be added under and the root would then be refused as outside the pool (review minor F6) —
/// unreachable: both universe constructors refuse a champion with no positions (`NoPositions`), the
/// live loader drops one, and every listed position is playable (`playable_roles` falls back to the
/// positions and the refresh writes `positions ⊆ playable`), so a champion in a universe always has
/// a role.
pub fn with_board_picks(tags: RoleSets, board: ChampionSet, universe: &Universe) -> RoleSets {
    let listed = tags.union();
    board
        .iter()
        .filter(|c: &ChampionIdx| !listed.contains(*c))
        .fold(tags, |tags, c| tags.with_meta_roles(c, universe))
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
