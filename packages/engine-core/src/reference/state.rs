//! The reference state (design § 2, D5, D8): a declared format plus one entry per filled
//! slot. Side-to-move comes from the slot, never from counts. A pair turn is one action; a
//! half-filled pair (only ever at a fixture's root) is completed by a single pick.

use super::format::{Format, Slot};
use super::universe::{ChampionIdx, ChampionSet, Universe};
use crate::draft_state::{ActionType, Side};

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

/// A side's pool is a set (D4): a champion outside it is not a pick for that side; bans are unrestricted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pools {
    pub blue: ChampionSet,
    pub red: ChampionSet,
}

impl Pools {
    pub fn for_side(&self, side: Side) -> ChampionSet {
        match side {
            Side::Blue => self.blue,
            Side::Red => self.red,
        }
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
                    pos.picks_mut(slot.side).push(c);
                }
                _ => return Err(PositionError::KindMismatch { slot: i }),
            }
            pos.entries.push(*entry);
        }
        Ok(pos)
    }

    fn picks_mut(&mut self, side: Side) -> &mut Vec<ChampionIdx> {
        match side {
            Side::Blue => &mut self.blue,
            Side::Red => &mut self.red,
        }
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

    pub fn taken(&self) -> ChampionSet {
        self.taken
    }

    pub fn available(&self, universe: &Universe) -> ChampionSet {
        universe.all().minus(self.taken)
    }

    pub fn picks(&self, side: Side) -> &[ChampionIdx] {
        match side {
            Side::Blue => &self.blue,
            Side::Red => &self.red,
        }
    }

    /// Ban slot: every available champion. Pick slot: every available champion in the mover's
    /// pool — all unordered pairs at a pair's first half, singles otherwise. Never `Skip`.
    pub fn legal_actions(&self, universe: &Universe, pools: &Pools) -> Vec<Action> {
        let Some(slot) = self.next_slot() else {
            return Vec::new();
        };
        let available = self.available(universe);
        match slot.action {
            ActionType::Ban => available.iter().map(Action::Ban).collect(),
            ActionType::Pick => {
                let mine: Vec<ChampionIdx> = available
                    .intersect(pools.for_side(slot.side))
                    .iter()
                    .collect();
                if slot.pair_start {
                    let mut pairs =
                        Vec::with_capacity(mine.len() * mine.len().saturating_sub(1) / 2);
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
        self.picks_mut(side).push(c);
    }
}
