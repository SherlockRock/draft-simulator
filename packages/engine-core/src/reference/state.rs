//! The reference state (design § 2, D5, D8): a declared format plus one entry per filled
//! slot. Side-to-move comes from the slot, never from counts. A pair turn is one action; a
//! half-filled pair (only ever at a fixture's root) is completed by a single pick.

use super::format::{Format, Slot};
use super::universe::{ChampionIdx, ChampionSet, Universe};
use crate::draft_state::{ActionType, Side};
use crate::feasibility::ROLES;
use crate::pools::Role;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    Ban(ChampionIdx),
    /// A recorded "no ban" (D5): occupies the slot, removes nothing. Never generated.
    Skip,
    Pick(ChampionIdx),
}

/// Derive order = canonical order: bans, then picks, then pairs, each by index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Action {
    Ban(ChampionIdx),
    Pick(ChampionIdx),
    /// Unordered; always stored `lo < hi` — build with [`Action::pair`].
    Pair(ChampionIdx, ChampionIdx),
}

impl Action {
    pub fn pair(a: ChampionIdx, b: ChampionIdx) -> Self {
        if a <= b {
            Action::Pair(a, b)
        } else {
            Action::Pair(b, a)
        }
    }

    pub fn champions(self) -> impl Iterator<Item = ChampionIdx> {
        let (first, second) = match self {
            Action::Ban(c) | Action::Pick(c) => (c, None),
            Action::Pair(a, b) => (a, Some(b)),
        };
        std::iter::once(first).chain(second)
    }
}

/// One side's pool by role (role-aware pools design § 1): the champions the pool lists for each role,
/// in `crate::feasibility::ROLES` order (top, jungle, middle, adc, support). A champion may sit under
/// several roles (RA1) and under a role the meta does not list for it (RA4: the entry makes that role
/// playable for this side).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoleSets {
    by_role: [ChampionSet; 5],
}

impl RoleSets {
    fn slot(role: Role) -> usize {
        match role {
            Role::Top => 0,
            Role::Jungle => 1,
            Role::Middle => 2,
            Role::Adc => 3,
            Role::Support => 4,
        }
    }

    /// `c` listed under `role`, beside whatever it is already listed under.
    pub fn with(mut self, role: Role, c: ChampionIdx) -> Self {
        let slot = Self::slot(role);
        self.by_role[slot] = self.by_role[slot].with(c);
        self
    }

    pub fn for_role(&self, role: Role) -> ChampionSet {
        self.by_role[Self::slot(role)]
    }

    /// Every champion listed under any role: the pool as a set.
    pub fn union(&self) -> ChampionSet {
        self.by_role
            .iter()
            .fold(ChampionSet::EMPTY, |all, set| all.union(*set))
    }

    /// The list form of `set` as tags: each champion under every role the meta lists for it. The
    /// definition "a list means every meta role" made a value (design, Definitions).
    pub fn meta_roles(set: ChampionSet, universe: &Universe) -> Self {
        set.iter().fold(Self::default(), |tags, c| {
            ROLES
                .iter()
                .enumerate()
                .filter(|(bit, _)| (universe.role_mask(c) >> bit) & 1 == 1)
                .fold(tags, |tags, (_, role)| tags.with(*role, c))
        })
    }
}

/// A side's pool as a set (D4): a champion outside it is not a pick for that side under the gate; bans
/// are unrestricted. `blue_roles` / `red_roles` are the optional role tags (role-aware pools design
/// § 1): `None` is list form — every reader runs the set code — and `Some` must list exactly the
/// champions of the side's set ([`Pools::with_roles`] keeps the two in step). Tags are read only under
/// a live rule on a five-pick format (`feasibility::tags_for`); a search or an oracle run refuses them
/// anywhere else.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pools {
    pub blue: ChampionSet,
    pub red: ChampionSet,
    pub blue_roles: Option<RoleSets>,
    pub red_roles: Option<RoleSets>,
}

impl Pools {
    pub fn for_side(&self, side: Side) -> ChampionSet {
        match side {
            Side::Blue => self.blue,
            Side::Red => self.red,
        }
    }

    /// `side`'s role tags, when its pool carries them.
    pub fn roles(&self, side: Side) -> Option<&RoleSets> {
        match side {
            Side::Blue => self.blue_roles.as_ref(),
            Side::Red => self.red_roles.as_ref(),
        }
    }

    /// `side`'s pool replaced by `roles`: the set becomes their union, so the two cannot disagree.
    pub fn with_roles(mut self, side: Side, roles: RoleSets) -> Self {
        match side {
            Side::Blue => {
                self.blue = roles.union();
                self.blue_roles = Some(roles);
            }
            Side::Red => {
                self.red = roles.union();
                self.red_roles = Some(roles);
            }
        }
        self
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PositionError {
    #[error("slot {slot}: beyond the format's {len} slots")]
    SlotOutOfRange { slot: usize, len: usize },
    #[error("slot {slot}: skip on a pick slot")]
    SkipOnPickSlot { slot: usize },
    #[error("slot {slot}: entry kind does not match the slot")]
    KindMismatch { slot: usize },
    #[error("slot {slot}: champion {id} is already on the board")]
    DuplicateChampion { slot: usize, id: String },
    #[error("slot {slot}: champion {id} is not in the mover's pool")]
    PickOutsidePool { slot: usize, id: String },
}

/// `blue` / `red` are kept **index-sorted** (slice-5 U3): a leaf value computed over them is then a
/// function of the pick SETS, so two paths to the same board give bit-equal values on any floats.
#[derive(Clone, Debug)]
pub struct Position<'f> {
    format: &'f Format,
    entries: Vec<Entry>,
    taken: ChampionSet,
    blue: Vec<ChampionIdx>,
    red: Vec<ChampionIdx>,
}

impl<'f> Position<'f> {
    pub fn new(
        format: &'f Format,
        entries: &[Entry],
        pools: &Pools,
        universe: &Universe,
    ) -> Result<Self, PositionError> {
        let mut pos = Self {
            format,
            entries: Vec::with_capacity(entries.len()),
            taken: ChampionSet::EMPTY,
            blue: Vec::new(),
            red: Vec::new(),
        };
        for (i, entry) in entries.iter().enumerate() {
            let slot = format.slot(i).ok_or(PositionError::SlotOutOfRange {
                slot: i,
                len: format.slots().len(),
            })?;
            match (*entry, slot.action) {
                (Entry::Skip, ActionType::Ban) => {}
                (Entry::Skip, ActionType::Pick) => {
                    return Err(PositionError::SkipOnPickSlot { slot: i })
                }
                (Entry::Ban(c), ActionType::Ban) => {
                    if pos.taken.contains(c) {
                        return Err(PositionError::DuplicateChampion {
                            slot: i,
                            id: universe.id(c).to_string(),
                        });
                    }
                    pos.taken = pos.taken.with(c);
                }
                (Entry::Pick(c), ActionType::Pick) => {
                    if pos.taken.contains(c) {
                        return Err(PositionError::DuplicateChampion {
                            slot: i,
                            id: universe.id(c).to_string(),
                        });
                    }
                    if !pools.for_side(slot.side).contains(c) {
                        return Err(PositionError::PickOutsidePool {
                            slot: i,
                            id: universe.id(c).to_string(),
                        });
                    }
                    pos.taken = pos.taken.with(c);
                    pos.insert_pick(slot.side, c);
                }
                _ => return Err(PositionError::KindMismatch { slot: i }),
            }
            pos.entries.push(*entry);
        }
        Ok(pos)
    }

    /// Sorted insert (U3): the pick lists are index-sorted sets, never slot-ordered.
    fn insert_pick(&mut self, side: Side, c: ChampionIdx) {
        let picks = match side {
            Side::Blue => &mut self.blue,
            Side::Red => &mut self.red,
        };
        let at = picks.partition_point(|&p| p < c);
        picks.insert(at, c);
    }

    pub fn format(&self) -> &'f Format {
        self.format
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Index of the next slot to fill (= number of entries).
    pub fn slot_index(&self) -> usize {
        self.entries.len()
    }

    pub fn next_slot(&self) -> Option<Slot> {
        self.format.slot(self.entries.len())
    }

    pub fn is_complete(&self) -> bool {
        self.next_slot().is_none()
    }

    /// From the slot, never from counts (D8 4).
    pub fn mover(&self) -> Option<Side> {
        self.next_slot().map(|s| s.side)
    }

    /// The next slot is a pair's second half and the first half is filled. Only a fixture's
    /// root can be here (D8 2): `apply` always fills both halves of a pair.
    pub fn is_mid_pair(&self) -> bool {
        self.next_slot().is_some_and(|s| s.pair_end)
    }

    /// Everything unavailable: the board's bans and picks, plus any champions folded in by
    /// [`Position::with_excluded`].
    pub fn taken(&self) -> ChampionSet {
        self.taken
    }

    /// Cross-game exclusions (target note § 2; slice-5 U5): champions unavailable to both sides this
    /// game. Folded into `taken`, so they are never generated as bans or picks, never count towards
    /// feasibility, and ride the transposition key unchanged (constant within a search). Banning one
    /// would be a no-op — exactly the `Skip` D5 does not generate. A position rebuilt from
    /// `entries()` with `Position::new` does NOT carry them: re-apply this on every rebuild
    /// (`live::LiveRoot::position` does).
    pub fn with_excluded(mut self, excluded: ChampionSet) -> Self {
        self.taken = self.taken.union(excluded);
        self
    }

    pub fn available(&self, universe: &Universe) -> ChampionSet {
        universe.all().minus(self.taken)
    }

    /// Index-sorted (U3).
    pub fn picks(&self, side: Side) -> &[ChampionIdx] {
        match side {
            Side::Blue => &self.blue,
            Side::Red => &self.red,
        }
    }

    /// Ban slot: every available champion. Pick slot: every available champion in the mover's
    /// pool — all unordered pairs at a pair's first half, singles otherwise. Never `Skip`. This is
    /// the hard gate (D4, `FeasibilityRule::On`); `node::legal_actions_under` applies the
    /// `PoolOrRoster` widening on top of it.
    pub fn legal_actions(&self, universe: &Universe, pools: &Pools) -> Vec<Action> {
        let Some(slot) = self.next_slot() else {
            return Vec::new();
        };
        let available = self.available(universe);
        match slot.action {
            ActionType::Ban => available.iter().map(Action::Ban).collect(),
            ActionType::Pick => {
                self.pick_actions_from(available.intersect(pools.for_side(slot.side)))
            }
        }
    }

    /// The pick actions over an explicit candidate set at the next slot: all unordered pairs at a
    /// pair's first half, singles otherwise. Callers pass `available ∩ pool` (the gate) or
    /// `available` (the roster fallback, U10).
    pub fn pick_actions_from(&self, candidates: ChampionSet) -> Vec<Action> {
        let Some(slot) = self.next_slot() else {
            return Vec::new();
        };
        let mine: Vec<ChampionIdx> = candidates.iter().collect();
        if slot.pair_start {
            let mut pairs = Vec::with_capacity(mine.len() * mine.len().saturating_sub(1) / 2);
            for (i, &a) in mine.iter().enumerate() {
                for &b in &mine[i + 1..] {
                    pairs.push(Action::pair(a, b));
                }
            }
            pairs
        } else {
            mine.into_iter().map(Action::Pick).collect()
        }
    }

    /// The position after `action`. A `Pair` fills both halves.
    pub fn apply(&self, action: Action) -> Position<'f> {
        let slot = self
            .next_slot()
            .expect("apply on a complete draft is a programming error");
        debug_assert_eq!(
            matches!(action, Action::Pair(..)),
            slot.pair_start,
            "action shape must match the slot"
        );
        let mut next = self.clone();
        match action {
            Action::Ban(c) => {
                next.taken = next.taken.with(c);
                next.entries.push(Entry::Ban(c));
            }
            Action::Pick(c) => next.push_pick(slot.side, c),
            Action::Pair(a, b) => {
                next.push_pick(slot.side, a);
                next.push_pick(slot.side, b);
            }
        }
        next
    }

    fn push_pick(&mut self, side: Side, c: ChampionIdx) {
        self.taken = self.taken.with(c);
        self.entries.push(Entry::Pick(c));
        self.insert_pick(side, c);
    }
}
