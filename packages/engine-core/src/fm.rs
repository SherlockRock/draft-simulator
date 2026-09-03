//! Hand-rolled serving of the antisymmetric factorisation machine
//! (docs/designs/fm-evaluator-ship-design.md §2). No `ort`, no allocation on
//! the hot path: `perspective()` is computed once per `EvalContext::for_perspective`
//! and every score is dot products over fixed-size arrays.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Once;

pub const RANK: usize = 16;

#[derive(Clone, Debug, Deserialize)]
pub struct FmChampion {
    /// The served linear term: Σ_r p(r|c)·w[c][r], baked at export (design §2 "Roles").
    pub linear_expected: f64,
    /// Provenance only — the per-role 5-vector in `linear_roles` order. Never read at serve time.
    #[serde(default)]
    pub linear: Vec<f64>,
    pub synergy: [f64; RANK],
    pub counter_a: [f64; RANK],
    pub counter_b: [f64; RANK],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FmSideSum {
    pub s: [f64; RANK],
    pub a: [f64; RANK],
    pub b: [f64; RANK],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FmPerspective {
    pub team: FmSideSum,
    pub opp: FmSideSum,
}

#[derive(Debug, thiserror::Error)]
pub enum FmParseError {
    #[error("fm-weights: {0}")]
    Json(#[from] serde_json::Error),
    #[error("fm-weights: format {0} but this build reads format 1")]
    Format(u32),
    #[error("fm-weights: rank {0} but this build serves rank {RANK}")]
    Rank(usize),
    #[error("fm-weights: scale must be finite and > 0, got {0}")]
    Scale(f64),
    #[error("fm-weights: no champions")]
    Empty,
}

#[derive(Deserialize)]
struct FmWeightsFile {
    version: String,
    #[serde(default)]
    format: u32,
    rank: usize,
    scale: f64,
    #[serde(default)]
    trained_on: serde_json::Value,
    champions: HashMap<String, FmChampion>,
}

#[derive(Debug)]
pub struct FmWeights {
    pub version: String,
    pub scale: f64,
    pub patches: Vec<String>,
    champions: HashMap<String, FmChampion>,
    scored: AtomicUsize,
    clamped: AtomicUsize,
}

static MISSING_LOGGED: Once = Once::new();

fn dot(x: &[f64; RANK], y: &[f64; RANK]) -> f64 {
    x.iter().zip(y).map(|(a, b)| a * b).sum()
}

fn add_into(acc: &mut [f64; RANK], v: &[f64; RANK]) {
    for (a, b) in acc.iter_mut().zip(v) {
        *a += b;
    }
}

impl FmWeights {
    pub fn from_json_str(raw: &str) -> Result<Self, FmParseError> {
        let file: FmWeightsFile = serde_json::from_str(raw)?;
        if file.format != 1 {
            return Err(FmParseError::Format(file.format));
        }
        if file.rank != RANK {
            return Err(FmParseError::Rank(file.rank));
        }
        if !(file.scale.is_finite() && file.scale > 0.0) {
            return Err(FmParseError::Scale(file.scale));
        }
        if file.champions.is_empty() {
            return Err(FmParseError::Empty);
        }
        let patches = file
            .trained_on
            .get("patches")
            .and_then(|p| p.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        Ok(Self {
            version: file.version,
            scale: file.scale,
            patches,
            champions: file.champions,
            scored: AtomicUsize::new(0),
            clamped: AtomicUsize::new(0),
        })
    }

    pub fn champion(&self, alias: &str) -> Option<&FmChampion> {
        self.champions.get(alias)
    }

    pub fn len(&self) -> usize {
        self.champions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.champions.is_empty()
    }

    pub fn aliases(&self) -> impl Iterator<Item = &str> {
        self.champions.keys().map(String::as_str)
    }

    fn side_sum(&self, ids: &[String]) -> FmSideSum {
        let mut sum = FmSideSum::default();
        for id in ids {
            match self.champions.get(id) {
                Some(c) => {
                    add_into(&mut sum.s, &c.synergy);
                    add_into(&mut sum.a, &c.counter_a);
                    add_into(&mut sum.b, &c.counter_b);
                }
                // design §3: training's UNKNOWN padding — contributes nothing; logged once.
                None => MISSING_LOGGED.call_once(|| {
                    eprintln!("fm: champion {id:?} not in the FM table; padded as unknown (logged once)")
                }),
            }
        }
        sum
    }

    /// Aggregates for scoring from one side's perspective: `team` = that side's
    /// picks, `opp` = the other side's picks.
    pub fn perspective(&self, team: &[String], opp: &[String]) -> FmPerspective {
        FmPerspective { team: self.side_sum(team), opp: self.side_sum(opp) }
    }

    /// (synergy, counter) terms; `in_team` applies the self-exclusion `S_team − s_c`.
    fn terms(c: &FmChampion, p: &FmPerspective, in_team: bool) -> (f64, f64) {
        let mut syn = dot(&c.synergy, &p.team.s);
        if in_team {
            syn -= dot(&c.synergy, &c.synergy);
        }
        let ctr = dot(&c.counter_a, &p.opp.b) - dot(&c.counter_b, &p.opp.a);
        (syn, ctr)
    }

    /// Change in the structural logit from adding `c` to the team (design §2).
    pub fn marginal(&self, c: &FmChampion, p: &FmPerspective, in_team: bool) -> f64 {
        let (syn, ctr) = Self::terms(c, p, in_team);
        c.linear_expected + syn + ctr
    }

    /// Per-champion share whose per-side sums difference to the structural logit:
    /// synergy AND counter halved (design §2).
    pub fn allocation(&self, c: &FmChampion, p: &FmPerspective, in_team: bool) -> f64 {
        let (syn, ctr) = Self::terms(c, p, in_team);
        c.linear_expected + 0.5 * syn + 0.5 * ctr
    }

    /// design §3: `(0.5 + scale × contribution).clamp(0, 1)`; `allocation` for a team
    /// member (leaf path), `marginal` for a candidate. Counts clamp saturation for the A/B.
    pub fn comp_strength(&self, c: &FmChampion, p: &FmPerspective, in_team: bool) -> f64 {
        let contribution = if in_team { self.allocation(c, p, true) } else { self.marginal(c, p, false) };
        let raw = 0.5 + self.scale * contribution;
        self.scored.fetch_add(1, Ordering::Relaxed);
        if !(0.0..=1.0).contains(&raw) {
            self.clamped.fetch_add(1, Ordering::Relaxed);
        }
        raw.clamp(0.0, 1.0)
    }

    pub fn clamp_stats(&self) -> (usize, usize) {
        (self.scored.load(Ordering::Relaxed), self.clamped.load(Ordering::Relaxed))
    }

    pub fn reset_clamp_stats(&self) {
        self.scored.store(0, Ordering::Relaxed);
        self.clamped.store(0, Ordering::Relaxed);
    }
}
