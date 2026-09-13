//! A fixture's synthetic universe (design § 3, D1): champions with positions and a linear term,
//! a symmetric synergy table and an antisymmetric counter table. Ids are interned to `u8`
//! indices; sets are `u32` bitmasks. Strings appear only at the JSON boundary and in messages.

use crate::pools::Role;
use crate::role_solver::ChampionMeta;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub const MAX_CHAMPIONS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChampionIdx(pub u8);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ChampionSet(u32);

impl ChampionSet {
    pub const EMPTY: Self = Self(0);

    pub fn with(self, c: ChampionIdx) -> Self {
        Self(self.0 | (1u32 << c.0))
    }

    pub fn without(self, c: ChampionIdx) -> Self {
        Self(self.0 & !(1u32 << c.0))
    }

    pub fn contains(self, c: ChampionIdx) -> bool {
        self.0 & (1u32 << c.0) != 0
    }

    pub fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub fn intersect(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }

    pub fn minus(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }

    pub fn len(self) -> usize {
        self.0.count_ones() as usize
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn bits(self) -> u32 {
        self.0
    }

    pub fn iter(self) -> impl Iterator<Item = ChampionIdx> {
        (0..MAX_CHAMPIONS as u8)
            .map(ChampionIdx)
            .filter(move |c| self.contains(*c))
    }
}

impl FromIterator<ChampionIdx> for ChampionSet {
    fn from_iter<I: IntoIterator<Item = ChampionIdx>>(iter: I) -> Self {
        iter.into_iter().fold(Self::EMPTY, Self::with)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Champion {
    pub id: String,
    pub positions: Vec<Role>,
    pub linear: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SynergyEntry {
    pub pair: [String; 2],
    pub value: f64,
}

/// `of` counters `over` by `value`; the reverse direction is `-value` (D3: antisymmetric).
#[derive(Clone, Debug, Deserialize)]
pub struct CounterEntry {
    pub of: String,
    pub over: String,
    pub value: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UniverseSpec {
    pub champions: Vec<Champion>,
    #[serde(default)]
    pub synergy: Vec<SynergyEntry>,
    #[serde(default)]
    pub counter: Vec<CounterEntry>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum UniverseError {
    #[error("more than {MAX_CHAMPIONS} champions")]
    TooMany,
    #[error("duplicate champion id {0:?}")]
    DuplicateChampion(String),
    #[error("unknown champion id {0:?}")]
    UnknownChampion(String),
    #[error("{0:?} paired with itself")]
    SelfPair(String),
    #[error("duplicate table entry for {0:?} and {1:?}")]
    DuplicateEntry(String, String),
    #[error("non-finite parameter on {0:?}")]
    NonFinite(String),
    #[error("{0:?} lists no position")]
    NoPositions(String),
}

#[derive(Clone, Debug)]
pub struct Universe {
    champions: Vec<Champion>,
    index: HashMap<String, ChampionIdx>,
    synergy: Vec<Vec<f64>>,
    counter: Vec<Vec<f64>>,
    loss: f64,
    meta: HashMap<String, ChampionMeta>,
}

impl Universe {
    pub fn new(spec: UniverseSpec) -> Result<Self, UniverseError> {
        let n = spec.champions.len();
        if n > MAX_CHAMPIONS {
            return Err(UniverseError::TooMany);
        }
        let mut index = HashMap::with_capacity(n);
        for (i, c) in spec.champions.iter().enumerate() {
            if !c.linear.is_finite() {
                return Err(UniverseError::NonFinite(c.id.clone()));
            }
            if c.positions.is_empty() {
                return Err(UniverseError::NoPositions(c.id.clone()));
            }
            if index.insert(c.id.clone(), ChampionIdx(i as u8)).is_some() {
                return Err(UniverseError::DuplicateChampion(c.id.clone()));
            }
        }
        let lookup = |id: &str| -> Result<usize, UniverseError> {
            index
                .get(id)
                .map(|c| c.0 as usize)
                .ok_or_else(|| UniverseError::UnknownChampion(id.to_string()))
        };

        let mut synergy = vec![vec![0.0; n]; n];
        let mut seen = HashSet::new();
        for e in &spec.synergy {
            let (a, b) = (lookup(&e.pair[0])?, lookup(&e.pair[1])?);
            if a == b {
                return Err(UniverseError::SelfPair(e.pair[0].clone()));
            }
            if !e.value.is_finite() {
                return Err(UniverseError::NonFinite(e.pair[0].clone()));
            }
            if !seen.insert((a.min(b), a.max(b))) {
                return Err(UniverseError::DuplicateEntry(
                    e.pair[0].clone(),
                    e.pair[1].clone(),
                ));
            }
            synergy[a][b] = e.value;
            synergy[b][a] = e.value;
        }

        let mut counter = vec![vec![0.0; n]; n];
        let mut seen = HashSet::new();
        for e in &spec.counter {
            let (of, over) = (lookup(&e.of)?, lookup(&e.over)?);
            if of == over {
                return Err(UniverseError::SelfPair(e.of.clone()));
            }
            if !e.value.is_finite() {
                return Err(UniverseError::NonFinite(e.of.clone()));
            }
            if !seen.insert((of.min(over), of.max(over))) {
                return Err(UniverseError::DuplicateEntry(e.of.clone(), e.over.clone()));
            }
            counter[of][over] = e.value;
            counter[over][of] = -e.value;
        }

        let mut loss = 1.0;
        for c in &spec.champions {
            loss += c.linear.abs();
        }
        for a in 0..n {
            for b in (a + 1)..n {
                loss += synergy[a][b].abs() + counter[a][b].abs();
            }
        }

        let meta = spec
            .champions
            .iter()
            .map(|c| {
                (
                    c.id.clone(),
                    ChampionMeta {
                        id: c.id.clone(),
                        positions: c.positions.clone(),
                        ..Default::default()
                    },
                )
            })
            .collect();

        Ok(Self {
            champions: spec.champions,
            index,
            synergy,
            counter,
            loss,
            meta,
        })
    }

    pub fn len(&self) -> usize {
        self.champions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.champions.is_empty()
    }

    pub fn index(&self, id: &str) -> Option<ChampionIdx> {
        self.index.get(id).copied()
    }

    pub fn id(&self, c: ChampionIdx) -> &str {
        &self.champions[c.0 as usize].id
    }

    pub fn linear(&self, c: ChampionIdx) -> f64 {
        self.champions[c.0 as usize].linear
    }

    pub fn synergy(&self, a: ChampionIdx, b: ChampionIdx) -> f64 {
        self.synergy[a.0 as usize][b.0 as usize]
    }

    /// `ctr(blue, red)`: positive when the Blue champion counters the Red one.
    pub fn counter(&self, blue: ChampionIdx, red: ChampionIdx) -> f64 {
        self.counter[blue.0 as usize][red.0 as usize]
    }

    /// `L` (D3 ii): strictly larger than any reachable |U| in this universe.
    pub fn loss(&self) -> f64 {
        self.loss
    }

    pub fn all(&self) -> ChampionSet {
        (0..self.champions.len())
            .map(|i| ChampionIdx(i as u8))
            .collect()
    }

    /// Positions only; every other `ChampionMeta` field is `Default`. `role_solver::solve` is never
    /// called on this map — only `feasibility::can_complete_roles` reads it.
    pub fn champion_meta(&self) -> &HashMap<String, ChampionMeta> {
        &self.meta
    }

    pub fn names(&self, champions: &[ChampionIdx]) -> Vec<String> {
        champions.iter().map(|c| self.id(*c).to_string()).collect()
    }

    pub fn names_of(&self, set: ChampionSet) -> Vec<String> {
        set.iter().map(|c| self.id(c).to_string()).collect()
    }
}
