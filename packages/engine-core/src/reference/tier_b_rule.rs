//! The pre-registered P/Q rule of the Tier B review (design docs/designs/tier-b-review-tool-design.md
//! § 4) and everything printed beside its pick: the receipt, the sensitivity line, the second line, the
//! floor rows, `never_everywhere`, `r_by_label`, `reveal_changes`, the worklist.
//!
//! Pure. The runner (`tier_b_review`) prepares one `PositionInput` per position from the full, unpruned
//! rankings; this module only sums `score_ranking`'s readings per arm and chooses. Nothing here reads a
//! search or leaf type, so a constructed input exercises every key.
//!
//! **Pre-registered:** the three keys and their order, ε, the grid, the tie-break, what "readable"
//! means and the blind fold are design § 4's. None is a knob.

use super::live::DEFAULT_SYNERGY_WEIGHT;
use super::state::Action;
use super::tier_b::{CorpusSplit, Label, OptionKey};
use super::tier_b_review::{score_ranking, OwnPick, PositionScore, ScoredAction, TopClassName};
use crate::draft_state::Side;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The two other margins of the sensitivity line (the first is the run's own, 0.01).
pub const SENSITIVITY_MARGINS: [f64; 2] = [0.005, 0.02];

/// The share-ratio cut-offs of the floor rows.
pub const FLOOR_RATIOS: [f64; 2] = [0.10, 0.25];

// ---- the input --------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmRole {
    PoolOrRoster,
    /// A selectable arm of the grid (the reference arm included).
    Roster,
    /// A comparison row: the reference ranking with options removed. Never selectable.
    Floor,
    /// A roster arm at the reference P and Q searched at a synergy weight `w ≠ w₀`. Feeds the catalog
    /// and the `w` read, never the P × Q rule.
    Weight,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArmSpec {
    pub id: String,
    pub role: ArmRole,
    pub p: Option<f64>,
    pub q: Option<f64>,
    /// The synergy weight, on `ArmRole::Weight` arms only.
    pub w: Option<f64>,
}

/// One label fold: the labels, and the own pick it reads (`None`: no view, or not answered).
#[derive(Clone, Debug, Default)]
pub struct Fold {
    pub labels: HashMap<OptionKey, Label>,
    pub own_pick: Option<Action>,
}

/// The #1's option and line at one arm, for `bad_line@1` and the worklist.
#[derive(Clone, Debug, PartialEq)]
pub struct TopLine {
    pub option: OptionKey,
    pub option_id: String,
    /// Canonical: each turn's champions `+`-joined in byte order, turns joined by ` > `.
    pub line: String,
}

/// One position at one arm (or floor row), as the runner hands it over: the full, mover-ordered ranking.
#[derive(Clone, Debug)]
pub struct ArmInput {
    pub id: String,
    /// A pick root whose search neither failed nor was cut.
    pub speaks: bool,
    pub ranking: Vec<ScoredAction>,
    /// For each own pick either fold reads: whether it is in-pool at this arm.
    pub own_in_pool: Vec<(Action, bool)>,
    pub top_line: Option<TopLine>,
    /// Floor rows: kept options holding an off-pool placement of unknown share ratio.
    pub unknown_r_kept: usize,
}

/// Share-ratio buckets of `r_by_label`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RBucket {
    Below10,
    Below25,
    Below50,
    Below100,
    One,
    Unknown,
}

impl RBucket {
    pub const ALL: [RBucket; 6] = [
        RBucket::Below10,
        RBucket::Below25,
        RBucket::Below50,
        RBucket::Below100,
        RBucket::One,
        RBucket::Unknown,
    ];

    pub fn of(r: Option<f64>) -> RBucket {
        match r {
            None => RBucket::Unknown,
            Some(r) if r < 0.1 => RBucket::Below10,
            Some(r) if r < 0.25 => RBucket::Below25,
            Some(r) if r < 0.5 => RBucket::Below50,
            Some(r) if r < 1.0 => RBucket::Below100,
            Some(_) => RBucket::One,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            RBucket::Below10 => "r < 0.1",
            RBucket::Below25 => "r < 0.25",
            RBucket::Below50 => "r < 0.5",
            RBucket::Below100 => "r < 1",
            RBucket::One => "r = 1",
            RBucket::Unknown => "r unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabelChange {
    pub option: String,
    pub blind: Label,
    pub current: Label,
}

/// Blind and current own picks as option-like text (`A+B`, ids sorted); `None` is "no view".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickChange {
    pub blind: Option<String>,
    pub current: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RevealRead {
    /// Any entry of the fixture is `scored`.
    pub revealed: bool,
    /// How many labels were given blind (the denominator of the change count).
    pub blind_labels: usize,
    pub blind_pick: bool,
    pub label_changes: Vec<LabelChange>,
    pub pick_change: Option<PickChange>,
}

#[derive(Clone, Debug)]
pub struct PositionInput {
    pub id: String,
    pub draft: String,
    pub mover: Side,
    /// `depth_check.stable`; `None` where the check was off or could not run.
    pub stable: Option<bool>,
    /// The rule's fold: blind, an option labelled only after the reveal reading its current label.
    pub rule: Fold,
    pub current: Fold,
    /// Options of the rule fold that fell back to their current label.
    pub label_fallbacks: usize,
    /// The rule fold's own pick came from the current fold (none was given blind).
    pub pick_fallback: bool,
    /// Line verdicts by (option, canonical line): `ok`.
    pub lines: HashMap<(OptionKey, String), bool>,
    /// The arms and the floor rows, found by id.
    pub arms: Vec<ArmInput>,
    /// Catalog rows with no label in the rule fold: what is left to label.
    pub unlabelled_rows: Vec<String>,
    /// Options with exactly one off-pool placement, by that placement's share ratio, with the rule
    /// fold's label.
    pub r_labels: Vec<(RBucket, Label)>,
    pub reveal: RevealRead,
    /// Development positions feed the rule and everything beside it; holdout positions only the
    /// holdout's own read (engine slice B design § 5).
    pub split: CorpusSplit,
}

// ---- the sums ---------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineState {
    /// No #1 line to read (the position does not speak).
    None,
    Unjudged,
    Good,
    Bad,
}

/// One position's reading at one arm, kept so a subset can be re-summed.
#[derive(Clone, Debug)]
pub struct PositionRow {
    pub id: String,
    pub draft: String,
    pub stable: Option<bool>,
    /// `None` where the position does not speak at this arm.
    pub score: Option<PositionScore>,
    pub line: LineState,
    pub top_line: Option<TopLine>,
}

/// The per-arm sums of design § 4's table and per-arm list. Indexed like `SCORE_KS` (1, 3, 5, 10).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Metrics {
    pub positions: usize,
    /// Positions that speak. Only they are summed below.
    pub speaking: usize,
    pub never: [usize; 4],
    pub near: [usize; 4],
    pub unjudged: [usize; 4],
    pub play: [usize; 4],
    pub no_play: [usize; 4],
    pub neither_play: [usize; 4],
    pub pick: [usize; 4],
    pub pick_off: [usize; 4],
    /// Positions with an own pick (the denominator of `pick`).
    pub with_pick: usize,
    /// Positions whose own pick is off-pool (the denominator of `pick_off`).
    pub pick_off_eligible: usize,
    /// `never@1`, split by the #1's class.
    pub never_1_in_pool: usize,
    pub never_1_base: usize,
    pub never_1_graded: usize,
    pub top_in_pool: usize,
    /// Over positions with an own pick, an absent one as infinity.
    pub pick_median_rank: Option<f64>,
    pub pick_absent: usize,
    /// Over own picks that are ranked; `None` when none is left.
    pub pick_median_regret: Option<f64>,
    pub opp_charge_lead: usize,
    pub bad_line: usize,
    /// A #1 line with a verdict. `bad_line` of `judged_line` is the printed form.
    pub judged_line: usize,
    pub unjudged_line: usize,
    /// Speaking positions whose #1 has no line to judge (an empty continuation, slot 19): in none of
    /// the three line counts above.
    pub no_line: usize,
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let n = values.len();
    Some(if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    })
}

impl Metrics {
    pub fn sum<'a>(rows: impl IntoIterator<Item = &'a PositionRow>) -> Metrics {
        let mut m = Metrics::default();
        let mut ranks = Vec::new();
        let mut regrets = Vec::new();
        for row in rows {
            m.positions += 1;
            match row.line {
                LineState::None => m.no_line += usize::from(row.score.is_some()),
                LineState::Unjudged => m.unjudged_line += 1,
                LineState::Good => m.judged_line += 1,
                LineState::Bad => {
                    m.judged_line += 1;
                    m.bad_line += 1;
                }
            }
            let Some(s) = &row.score else { continue };
            m.speaking += 1;
            for j in 0..4 {
                m.never[j] += usize::from(s.never[j]);
                m.near[j] += usize::from(s.near[j]);
                m.unjudged[j] += usize::from(s.unjudged[j]);
                m.play[j] += usize::from(s.play[j]);
                m.no_play[j] += usize::from(s.no_play[j]);
                m.neither_play[j] += usize::from(s.neither_play[j]);
                m.pick[j] += usize::from(s.pick[j]);
                m.pick_off[j] += usize::from(s.pick_off[j]);
            }
            if s.never[0] {
                match s.class_at_1 {
                    Some(TopClassName::InPool) => m.never_1_in_pool += 1,
                    Some(TopClassName::Base) => m.never_1_base += 1,
                    Some(TopClassName::Graded) => m.never_1_graded += 1,
                    None => {}
                }
            }
            m.top_in_pool += usize::from(s.class_at_1 == Some(TopClassName::InPool));
            m.pick_off_eligible += usize::from(s.pick_off_eligible);
            m.opp_charge_lead += usize::from(s.opp_lead);
            match s.own {
                OwnPick::NoPick => {}
                OwnPick::Absent => {
                    m.with_pick += 1;
                    m.pick_absent += 1;
                    ranks.push(f64::INFINITY);
                }
                OwnPick::Ranked { rank, regret } => {
                    m.with_pick += 1;
                    ranks.push(rank as f64);
                    regrets.push(regret);
                }
            }
        }
        m.pick_median_rank = median(ranks);
        m.pick_median_regret = median(regrets);
        m
    }
}

/// One arm's (or floor row's) reading of the whole corpus.
#[derive(Clone, Debug)]
pub struct ArmScore {
    pub spec: ArmSpec,
    pub rows: Vec<PositionRow>,
    pub all: Metrics,
    /// Floor rows: kept options holding an off-pool placement of unknown share ratio, summed over the
    /// positions (`ArmInput.unknown_r_kept`). Zero for an ordinary arm.
    pub unknown_r_kept: usize,
}

/// Readable whatever the arm's role: positions > 0, every position speaks, `unjudged@1` and
/// `unjudged@3` both 0. A read over no positions is never readable.
pub fn readable_metrics(m: &Metrics) -> bool {
    m.positions > 0 && m.speaking == m.positions && m.unjudged[0] == 0 && m.unjudged[1] == 0
}

impl ArmScore {
    pub fn new(spec: ArmSpec, rows: Vec<PositionRow>) -> ArmScore {
        let all = Metrics::sum(&rows);
        ArmScore {
            spec,
            rows,
            all,
            unknown_r_kept: 0,
        }
    }

    /// Selectable by the rule: a roster arm where every position speaks and neither `unjudged@1` nor
    /// `unjudged@3` is left (the second does not imply the first). `pool_or_roster` and the floor rows
    /// are never selectable.
    pub fn readable(&self) -> bool {
        self.spec.role == ArmRole::Roster && readable_metrics(&self.all)
    }

    pub fn without_draft(&self, draft: &str) -> ArmScore {
        ArmScore {
            unknown_r_kept: self.unknown_r_kept,
            ..ArmScore::new(
                self.spec.clone(),
                self.rows
                    .iter()
                    .filter(|r| r.draft != draft)
                    .cloned()
                    .collect(),
            )
        }
    }

    pub fn metrics_where(&self, keep: impl Fn(&PositionRow) -> bool) -> Metrics {
        Metrics::sum(self.rows.iter().filter(|r| keep(r)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldKind {
    /// Blind, falling back to current per option.
    Rule,
    Current,
}

fn row_of(pos: &PositionInput, spec: &ArmSpec, fold: FoldKind, margin: f64) -> PositionRow {
    let mut row = PositionRow {
        id: pos.id.clone(),
        draft: pos.draft.clone(),
        stable: pos.stable,
        score: None,
        line: LineState::None,
        top_line: None,
    };
    let Some(input) = pos.arms.iter().find(|a| a.id == spec.id && a.speaks) else {
        return row;
    };
    let f = match fold {
        FoldKind::Rule => &pos.rule,
        FoldKind::Current => &pos.current,
    };
    let in_pool = f
        .own_pick
        .and_then(|p| input.own_in_pool.iter().find(|(a, _)| *a == p))
        .is_none_or(|(_, in_pool)| *in_pool);
    row.score = Some(score_ranking(
        pos.mover,
        &input.ranking,
        &f.labels,
        f.own_pick,
        in_pool,
        margin,
    ));
    // An empty line is no line (the runner already leaves it out; kept here for any other producer).
    if let Some(top) = input.top_line.as_ref().filter(|t| !t.line.is_empty()) {
        row.line = match pos.lines.get(&(top.option.clone(), top.line.clone())) {
            None => LineState::Unjudged,
            Some(true) => LineState::Good,
            Some(false) => LineState::Bad,
        };
        row.top_line = Some(top.clone());
    }
    row
}

/// One `ArmScore` per spec over `positions`, on the given fold and margin. A floor row goes through
/// the same seam as an arm: `score_ranking` on its filtered ranking.
pub fn read_arms(
    positions: &[&PositionInput],
    specs: &[ArmSpec],
    fold: FoldKind,
    margin: f64,
) -> Vec<ArmScore> {
    specs
        .iter()
        .map(|spec| ArmScore {
            unknown_r_kept: positions
                .iter()
                .flat_map(|p| p.arms.iter())
                .filter(|a| a.id == spec.id)
                .map(|a| a.unknown_r_kept)
                .sum(),
            ..ArmScore::new(
                spec.clone(),
                positions
                    .iter()
                    .map(|p| row_of(p, spec, fold, margin))
                    .collect(),
            )
        })
        .collect()
}

// ---- the rule ---------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    P,
    Q,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeSide {
    Bottom,
    Top,
}

/// The pick sits at an end of a sweep.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edge {
    pub axis: Axis,
    pub side: EdgeSide,
    pub value: f64,
}

impl Edge {
    /// Design § 4's wording. The top of either sweep says to read the evidence before widening; Q = 0
    /// (design) says the off-role grade is doing no work, and P = 0 the same of the off-pool price. A
    /// bottom edge above zero (controller ruling) prints the bare flag, with no advice.
    pub fn text(&self) -> String {
        let (name, idle) = match self.axis {
            Axis::P => ("P", "the off-pool price is doing no work here"),
            Axis::Q => ("Q", "the off-role grade is doing no work here"),
        };
        let flag = format!("on the grid's edge ({name} = {})", self.value);
        match (self.side, self.value == 0.0) {
            (EdgeSide::Bottom, true) => format!("{flag}: {idle}"),
            (EdgeSide::Bottom, false) => flag,
            (EdgeSide::Top, _) => {
                format!("{flag}: read r_by_label and the floor rows before widening")
            }
        }
    }
}

/// What the move from the reference arm to the pick does, on every metric.
#[derive(Clone, Debug, PartialEq)]
pub struct Split {
    pub positions: Vec<String>,
    pub from: Metrics,
    pub to: Metrics,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub reference: String,
    pub pick: String,
    /// The reference arm's metrics, then the pick's: `never@1 7 → 0` reads `from`, `to`.
    pub from: Metrics,
    pub to: Metrics,
    /// Own picks that leave the top 3 (`pick@3` held at the reference, not at the pick): what the move
    /// loses.
    pub leaves_top_3: Vec<String>,
    pub enters_top_3: Vec<String>,
    /// Positions whose `depth_check` did not hold, counted apart. All count in the rule.
    pub unstable: Split,
    /// Every other position (a held check, or none run).
    pub stable: Split,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuleOutcome {
    /// Roster arms in the run (the "48" of "N of 48").
    pub roster_arms: usize,
    pub readable: usize,
    /// The arms tied on the three keys, in run order.
    pub ties: Vec<String>,
    pub pick: Option<String>,
    pub edge: Vec<Edge>,
    pub receipt: Option<Receipt>,
}

/// The grid's axes: the sorted, distinct P and Q of the roster arms.
pub fn grid_axes(arms: &[ArmScore]) -> (Vec<f64>, Vec<f64>) {
    let sorted = |f: fn(&ArmSpec) -> Option<f64>| {
        let mut v: Vec<f64> = arms
            .iter()
            .filter(|a| a.spec.role == ArmRole::Roster)
            .filter_map(|a| f(&a.spec))
            .collect();
        v.sort_by(f64::total_cmp);
        v.dedup();
        v
    };
    (sorted(|s| s.p), sorted(|s| s.q))
}

fn index_of(axis: &[f64], v: Option<f64>) -> Option<usize> {
    let v = v?;
    axis.iter().position(|x| *x == v)
}

/// Design § 4's rule: among the readable roster arms, fewest `never@1`, then fewest `never@3`, then
/// most `pick@3`; of the arms still tied, the reference arm if among them, else the fewest grid steps
/// from it (|Δ P index| + |Δ Q index|), then the smaller P, then the smaller Q.
pub fn choose_arm(arms: &[ArmScore], reference: &str) -> RuleOutcome {
    let roster_arms = arms
        .iter()
        .filter(|a| a.spec.role == ArmRole::Roster)
        .count();
    let readable: Vec<&ArmScore> = arms.iter().filter(|a| a.readable()).collect();
    let key = |a: &&ArmScore| {
        (
            a.all.never[0],
            a.all.never[1],
            std::cmp::Reverse(a.all.pick[1]),
        )
    };
    let Some(best) = readable.iter().map(key).min() else {
        return RuleOutcome {
            roster_arms,
            readable: 0,
            ties: Vec::new(),
            pick: None,
            edge: Vec::new(),
            receipt: None,
        };
    };
    let tied: Vec<&ArmScore> = readable
        .iter()
        .copied()
        .filter(|a| key(a) == best)
        .collect();
    let (ps, qs) = grid_axes(arms);
    let reference_arm = arms.iter().find(|a| a.spec.id == reference);
    let from = reference_arm.map(|a| {
        (
            index_of(&ps, a.spec.p).unwrap_or(0),
            index_of(&qs, a.spec.q).unwrap_or(0),
        )
    });
    let steps = |a: &ArmScore| match from {
        None => 0,
        Some((pi, qi)) => {
            let (ap, aq) = (
                index_of(&ps, a.spec.p).unwrap_or(0),
                index_of(&qs, a.spec.q).unwrap_or(0),
            );
            pi.abs_diff(ap) + qi.abs_diff(aq)
        }
    };
    let chosen = tied
        .iter()
        .copied()
        .find(|a| a.spec.id == reference)
        .unwrap_or_else(|| {
            tied.iter()
                .copied()
                .min_by(|a, b| {
                    steps(a)
                        .cmp(&steps(b))
                        .then(
                            a.spec
                                .p
                                .unwrap_or(f64::INFINITY)
                                .total_cmp(&b.spec.p.unwrap_or(f64::INFINITY)),
                        )
                        .then(
                            a.spec
                                .q
                                .unwrap_or(f64::INFINITY)
                                .total_cmp(&b.spec.q.unwrap_or(f64::INFINITY)),
                        )
                })
                .expect("tied is not empty: best came from it")
        });

    let mut edge = Vec::new();
    for (axis, values, at) in [(Axis::P, &ps, chosen.spec.p), (Axis::Q, &qs, chosen.spec.q)] {
        let (Some(at), Some(lo), Some(hi)) = (at, values.first(), values.last()) else {
            continue;
        };
        if lo == hi {
            continue;
        }
        if at == *hi {
            edge.push(Edge {
                axis,
                side: EdgeSide::Top,
                value: at,
            });
        }
        if at == *lo {
            edge.push(Edge {
                axis,
                side: EdgeSide::Bottom,
                value: at,
            });
        }
    }

    RuleOutcome {
        roster_arms,
        readable: readable.len(),
        ties: tied.iter().map(|a| a.spec.id.clone()).collect(),
        pick: Some(chosen.spec.id.clone()),
        edge,
        receipt: reference_arm.map(|r| receipt(r, chosen)),
    }
}

pub(super) fn receipt(reference: &ArmScore, pick: &ArmScore) -> Receipt {
    let held: BTreeMap<&str, bool> = pick
        .rows
        .iter()
        .map(|r| (r.id.as_str(), r.score.as_ref().is_some_and(|s| s.pick[1])))
        .collect();
    let (mut leaves, mut enters) = (Vec::new(), Vec::new());
    for row in &reference.rows {
        let was = row.score.as_ref().is_some_and(|s| s.pick[1]);
        let now = held.get(row.id.as_str()).copied().unwrap_or(false);
        if was && !now {
            leaves.push(row.id.clone());
        } else if !was && now {
            enters.push(row.id.clone());
        }
    }
    let split = |unstable: bool| {
        let keep = |r: &PositionRow| (r.stable == Some(false)) == unstable;
        Split {
            positions: reference
                .rows
                .iter()
                .filter(|r| keep(r))
                .map(|r| r.id.clone())
                .collect(),
            from: reference.metrics_where(keep),
            to: pick.metrics_where(keep),
        }
    };
    Receipt {
        reference: reference.spec.id.clone(),
        pick: pick.spec.id.clone(),
        from: reference.all.clone(),
        to: pick.all.clone(),
        leaves_top_3: leaves,
        enters_top_3: enters,
        unstable: split(true),
        stable: split(false),
    }
}

// ---- beside the pick --------------------------------------------------------------------------------

/// The pick at the two other margins and with each draft left out in turn: both are re-scorings of pure
/// functions. ε itself stays fixed at the run's.
#[derive(Clone, Debug, PartialEq)]
pub struct Sensitivity {
    pub margins: Vec<(f64, Option<String>)>,
    pub leave_out: Vec<(String, Option<String>)>,
    /// How many arms were readable in each re-read, in the order of the two lists above: a shrunken
    /// readable set would move the pick silently.
    pub margins_readable: Vec<usize>,
    pub leave_out_readable: Vec<usize>,
}

/// The rule on the current fold, flagged when its pick differs from the blind fold's.
#[derive(Clone, Debug)]
pub struct SecondLine {
    pub outcome: RuleOutcome,
    pub differs: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RByLabel {
    /// Per bucket in `RBucket::ALL` order: `[play, maybe, never]`.
    pub counts: [[usize; 3]; 6],
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RevealChanges {
    pub labels: Vec<(String, LabelChange)>,
    pub picks: Vec<(String, PickChange)>,
    pub blind_labels: usize,
    pub blind_picks: usize,
    pub drafts_revealed: Vec<String>,
    /// Revealed drafts where no label and no own pick changed.
    pub reveals_without_change: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fallbacks {
    pub labels: usize,
    pub picks: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnjudgedLine {
    pub position: String,
    pub option: String,
    pub line: String,
    /// The page offers a line verdict only on the reference arm's #1 line (design § 1). False where the
    /// pick's #1 option or line differs from the reference arm's at this position: no verdict given on
    /// the page can clear it.
    pub judgeable: bool,
}

/// What is left to do: the unlabelled rows per position, and the #1 lines at the rule's pick (the
/// reference arm where there is none) that have no line verdict.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Worklist {
    pub unlabelled_rows: Vec<(String, Vec<String>)>,
    pub lines_at: Option<String>,
    pub unjudged_lines: Vec<UnjudgedLine>,
}

impl Worklist {
    /// Listed lines no verdict on the page can clear.
    pub fn not_judgeable(&self) -> usize {
        self.unjudged_lines.iter().filter(|l| !l.judgeable).count()
    }
}

// ---- the w read (engine design § 4, pre-registered) --------------------------------------------------

/// One arm of the `w` read: the reference (`w₀`) or a weighted arm, read over the development positions
/// and, when the holdout is open, over the holdout positions.
#[derive(Clone, Debug, PartialEq)]
pub struct WeightArm {
    pub w: f64,
    pub id: String,
    pub development: Metrics,
    pub development_readable: bool,
    /// The holdout metrics and whether they are readable; `None` unless the holdout is open.
    pub holdout: Option<(Metrics, bool)>,
}

/// Why `w` stays at `w₀`, in the order design § 4 step 5 gives them (the first that applies).
#[derive(Clone, Debug, PartialEq)]
pub enum WeightReason {
    NoWeightBeatsOne,
    HoldoutSealed,
    HoldoutEmpty,
    /// The holdout is read but not readable at `at` (`w₀` first, then the pick): `unjudged` is
    /// the positions unjudged at k = 1 or k = 3 there, `silent` the positions that do not speak.
    HoldoutUnreadable {
        at: f64,
        unjudged: usize,
        silent: usize,
    },
    WorseOnHoldout {
        key: &'static str,
    },
    PickMovesWithout {
        draft: String,
    },
}

impl WeightReason {
    /// The words the summary and `metrics.weight.verdict.reason` carry. `w0` names the weight that stays.
    pub fn text(&self, w0: f64) -> String {
        match self {
            WeightReason::NoWeightBeatsOne => {
                format!("no weight beats w = {w0} on development")
            }
            WeightReason::HoldoutSealed => "the holdout is sealed".to_string(),
            WeightReason::HoldoutEmpty => "the holdout is empty".to_string(),
            WeightReason::HoldoutUnreadable {
                at,
                unjudged,
                silent,
            } => format!(
                "the holdout is not readable at w = {at} ({unjudged} unjudged at 1 or 3, {silent} silent)"
            ),
            WeightReason::WorseOnHoldout { key } => format!("worse on the holdout at {key}"),
            WeightReason::PickMovesWithout { draft } => {
                format!("the pick moves without {draft}")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WeightRead {
    /// The reference arm's P and Q, which every arm of the read shares.
    pub p: f64,
    pub q: f64,
    /// The reference arm (`w₀`) first, then each weighted arm in run order.
    pub arms: Vec<WeightArm>,
    /// The development pick (`w₀` when no weight beats it); `None` when the reference arm is unreadable
    /// on development, which leaves no read.
    pub pick: Option<f64>,
    pub recommend: Option<f64>,
    /// Why `recommend` is `None`; `None` too when there is no read at all.
    pub reason: Option<WeightReason>,
    /// The development pick with each development draft left out in turn.
    pub leave_out: Vec<(String, Option<f64>)>,
}

/// The holdout, as the `w` read sees it.
#[derive(Clone, Copy, Debug)]
pub enum HoldoutState<'a> {
    Sealed,
    Empty,
    /// The same arms read over the holdout positions.
    Open(&'a [ArmScore]),
}

/// Step 2 over the arms of the `w` axis: among the readable ones (`readable_metrics`, whatever the
/// role) the fewest `never@1`, then the fewest `never@3`, then the most `pick@3`; still tied, `w₀` if
/// among them, else the fewest steps from it along the sorted `w` axis (every arm of the read on it,
/// `w₀` included), then the smaller `w`. `None` when the reference arm is not readable (no read).
fn pick_weight(axis_arms: &[(&ArmScore, f64)], reference: &ArmScore, w0: f64) -> Option<f64> {
    if !readable_metrics(&reference.all) {
        return None;
    }
    let key = |a: &ArmScore| {
        (
            a.all.never[0],
            a.all.never[1],
            std::cmp::Reverse(a.all.pick[1]),
        )
    };
    let best = axis_arms
        .iter()
        .filter(|(a, _)| readable_metrics(&a.all))
        .map(|(a, _)| key(a))
        .min()?;
    let tied: Vec<f64> = axis_arms
        .iter()
        .filter(|(a, _)| readable_metrics(&a.all) && key(a) == best)
        .map(|(_, w)| *w)
        .collect();
    if tied.contains(&w0) {
        return Some(w0);
    }
    let mut axis: Vec<f64> = axis_arms.iter().map(|(_, w)| *w).collect();
    axis.sort_by(f64::total_cmp);
    axis.dedup();
    let at = |w: f64| axis.iter().position(|x| *x == w).unwrap_or(0);
    let from = at(w0);
    tied.into_iter().min_by(|a, b| {
        at(*a)
            .abs_diff(from)
            .cmp(&at(*b).abs_diff(from))
            .then(a.total_cmp(b))
    })
}

/// The `w` read of engine design § 4, pre-registered. `arms` are the reference arm (`reference`, at
/// `w₀`) and the weighted arms (`ArmRole::Weight`), read over the DEVELOPMENT positions only, so
/// `arm.all` is development's sums; every other arm in the list is ignored. `holdout` is the same arms
/// read over the holdout positions, when it is open. `None` when the run has no weighted arm.
///
/// 1. readable is `readable_metrics`, never `readable()` (false on a weighted arm by design);
/// 2. the development pick, `pick_weight`;
/// 3. the holdout: pick and `w₀` readable there, and the pick not worse on any KEY (`never@1` <=,
///    `never@3` <=, `pick@3` >=), not lexicographically;
/// 4. each development draft left out in turn: step 2 picks the same `w`;
/// 5. recommended only if the pick is not `w₀` and 3 and 4 pass; else the first reason that applies.
pub fn weight_read(
    arms: &[ArmScore],
    reference: &str,
    w0: f64,
    holdout: HoldoutState<'_>,
) -> Option<WeightRead> {
    let weights: Vec<(&ArmScore, f64)> = arms
        .iter()
        .filter(|a| a.spec.role == ArmRole::Weight)
        .filter_map(|a| a.spec.w.map(|w| (a, w)))
        .collect();
    if weights.is_empty() {
        return None;
    }
    let reference_arm = arms.iter().find(|a| a.spec.id == reference)?;
    let mut axis_arms: Vec<(&ArmScore, f64)> = vec![(reference_arm, w0)];
    axis_arms.extend(weights.iter().copied());

    let held = |id: &str| match holdout {
        HoldoutState::Open(h) => h.iter().find(|a| a.spec.id == id),
        _ => None,
    };
    let listed: Vec<WeightArm> = axis_arms
        .iter()
        .map(|(a, w)| WeightArm {
            w: *w,
            id: a.spec.id.clone(),
            development: a.all.clone(),
            development_readable: readable_metrics(&a.all),
            holdout: held(&a.spec.id).map(|h| (h.all.clone(), readable_metrics(&h.all))),
        })
        .collect();
    let mut read = WeightRead {
        p: reference_arm.spec.p.unwrap_or(f64::NAN),
        q: reference_arm.spec.q.unwrap_or(f64::NAN),
        arms: listed,
        pick: pick_weight(&axis_arms, reference_arm, w0),
        recommend: None,
        reason: None,
        leave_out: Vec::new(),
    };
    // No pick: the reference arm is unreadable on development, so there is no read.
    let Some(pick) = read.pick else {
        return Some(read);
    };

    // Step 4: each development draft left out in turn, on the arms of the axis only.
    let drafts: BTreeSet<&str> = reference_arm
        .rows
        .iter()
        .map(|r| r.draft.as_str())
        .collect();
    for d in drafts {
        let kept: Vec<ArmScore> = axis_arms.iter().map(|(a, _)| a.without_draft(d)).collect();
        let kept_axis: Vec<(&ArmScore, f64)> = kept
            .iter()
            .zip(&axis_arms)
            .map(|(k, (_, w))| (k, *w))
            .collect();
        read.leave_out
            .push((d.to_string(), pick_weight(&kept_axis, &kept[0], w0)));
    }

    // Step 5, the reasons in design § 4's order.
    let pick_arm = axis_arms
        .iter()
        .find(|(_, w)| *w == pick)
        .map(|(a, _)| *a)
        .expect("the pick is on the axis");
    let reason = if pick_arm.spec.id == reference_arm.spec.id {
        Some(WeightReason::NoWeightBeatsOne)
    } else {
        match holdout {
            HoldoutState::Sealed => Some(WeightReason::HoldoutSealed),
            HoldoutState::Empty => Some(WeightReason::HoldoutEmpty),
            HoldoutState::Open(_) => {
                // `w₀` first, then the pick: an unreadable opened holdout is a reason, never "not worse".
                let on_holdout = [(reference_arm, w0), (pick_arm, pick)]
                    .iter()
                    .map(|(a, w)| (held(&a.spec.id), *w))
                    .collect::<Vec<_>>();
                let unreadable = on_holdout
                    .iter()
                    .find(|(h, _)| !h.is_some_and(|h| readable_metrics(&h.all)));
                if let Some((h, w)) = unreadable {
                    let m = h.map(|h| &h.all);
                    // Positions unjudged at k = 1 or k = 3 (one that is both counts once).
                    let unjudged = h.map_or(0, |h| {
                        h.rows
                            .iter()
                            .filter(|r| {
                                r.score
                                    .as_ref()
                                    .is_some_and(|s| s.unjudged[0] || s.unjudged[1])
                            })
                            .count()
                    });
                    Some(WeightReason::HoldoutUnreadable {
                        at: *w,
                        unjudged,
                        silent: m.map_or(0, |m| m.positions - m.speaking),
                    })
                } else {
                    let (r, p) = (
                        &on_holdout[0].0.expect("readable").all,
                        &on_holdout[1].0.expect("readable").all,
                    );
                    let worse = [
                        ("never@1", p.never[0] > r.never[0]),
                        ("never@3", p.never[1] > r.never[1]),
                        ("pick@3", p.pick[1] < r.pick[1]),
                    ]
                    .into_iter()
                    .find(|(_, worse)| *worse)
                    .map(|(key, _)| WeightReason::WorseOnHoldout { key });
                    worse.or_else(|| {
                        read.leave_out
                            .iter()
                            .find(|(_, again)| *again != Some(pick))
                            .map(|(draft, _)| WeightReason::PickMovesWithout {
                                draft: draft.clone(),
                            })
                    })
                }
            }
        }
    };
    read.recommend = reason.is_none().then_some(pick);
    read.reason = reason;
    Some(read)
}

#[derive(Clone, Debug)]
pub struct Read {
    /// The rule fold's reading of every arm and floor row.
    pub arms: Vec<ArmScore>,
    pub rule: RuleOutcome,
    pub sensitivity: Sensitivity,
    pub second_line: SecondLine,
    pub never_everywhere: Vec<String>,
    pub r_by_label: RByLabel,
    pub reveal_changes: RevealChanges,
    pub fallbacks: Fallbacks,
    pub worklist: Worklist,
    /// The `w` read; `None` when no weighted arm is in the run.
    pub weight: Option<WeightRead>,
    /// The holdout positions' own read; `None` when the run has none.
    pub holdout: Option<HoldoutRead>,
}

/// What the run reads of its holdout positions (engine slice B design § 5). Sealed, only their count
/// and what is left to label; opened, the arms read over them alone.
#[derive(Clone, Debug)]
pub struct HoldoutRead {
    pub positions: usize,
    pub open: bool,
    /// Every arm and floor row read over the holdout positions (the rule fold); empty while sealed.
    pub arms: Vec<ArmScore>,
    /// The holdout's catalog rows with no label (option ids only, which the page shows anyway): in
    /// option-id order while sealed (the catalog's own order follows the rankings), as met once opened.
    pub unlabelled_rows: Vec<(String, Vec<String>)>,
}

/// Positions with a clear `never` at #1 at every readable arm: no P or Q fixes those. Empty when no arm
/// is readable.
pub fn never_everywhere(arms: &[ArmScore]) -> Vec<String> {
    let readable: Vec<&ArmScore> = arms.iter().filter(|a| a.readable()).collect();
    let Some(first) = readable.first() else {
        return Vec::new();
    };
    first
        .rows
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            readable
                .iter()
                .all(|a| a.rows[*i].score.as_ref().is_some_and(|s| s.never[0]))
        })
        .map(|(_, r)| r.id.clone())
        .collect()
}

/// The reference arm's #1 line at a position: the only one the page can judge.
fn reference_top<'a>(arms: &'a [ArmScore], reference: &str, position: &str) -> Option<&'a TopLine> {
    arms.iter()
        .find(|a| a.spec.id == reference)?
        .rows
        .iter()
        .find(|r| r.id == position)?
        .top_line
        .as_ref()
}

/// Everything of design § 4 over the corpus. `specs` lists the arms then the floor rows; `reference` is
/// the reference arm's id; `margin` is ε.
///
/// The split (engine slice B design § 5): the DEVELOPMENT positions alone feed the arms, the rule, the
/// sensitivity line, the second line, `never_everywhere`, `r_by_label`, the fallbacks, the worklist and
/// the `w` read's development side; `reveal_changes` too while the holdout is sealed, every position once
/// it is opened (`holdout_open`). The holdout positions are read apart (`Read.holdout`), and only when
/// opened; the `w` read's holdout is `Empty` without a holdout position (opened or not), else `Open` on
/// their own read when opened, else `Sealed`. With no holdout position every read is as before.
pub fn read_run(
    all: &[&PositionInput],
    specs: &[ArmSpec],
    reference: &str,
    margin: f64,
    holdout_open: bool,
) -> Read {
    let (development, held): (Vec<&PositionInput>, Vec<&PositionInput>) = all
        .iter()
        .partition(|p| p.split == CorpusSplit::Development);
    let positions = &development[..];
    let arms = read_arms(positions, specs, FoldKind::Rule, margin);
    let rule = choose_arm(&arms, reference);

    let (mut margins, mut margins_readable) = (Vec::new(), Vec::new());
    for m in SENSITIVITY_MARGINS {
        let again = choose_arm(&read_arms(positions, specs, FoldKind::Rule, m), reference);
        margins.push((m, again.pick));
        margins_readable.push(again.readable);
    }
    let drafts: BTreeSet<&str> = positions.iter().map(|p| p.draft.as_str()).collect();
    let (mut leave_out, mut leave_out_readable) = (Vec::new(), Vec::new());
    for d in &drafts {
        let kept: Vec<ArmScore> = arms.iter().map(|a| a.without_draft(d)).collect();
        let again = choose_arm(&kept, reference);
        leave_out.push((d.to_string(), again.pick));
        leave_out_readable.push(again.readable);
    }

    let current = choose_arm(
        &read_arms(positions, specs, FoldKind::Current, margin),
        reference,
    );
    let second_line = SecondLine {
        differs: current.pick != rule.pick,
        outcome: current,
    };

    let mut r_by_label = RByLabel::default();
    for p in positions {
        for (bucket, label) in &p.r_labels {
            let b = RBucket::ALL.iter().position(|x| x == bucket).unwrap_or(5);
            let l = match label {
                Label::Play => 0,
                Label::Maybe => 1,
                Label::Never => 2,
            };
            r_by_label.counts[b][l] += 1;
        }
    }

    let mut reveal = RevealChanges::default();
    let mut by_draft: BTreeMap<&str, (bool, bool)> = BTreeMap::new();
    // A sealed holdout is not named among the drafts revealed (its `scored` entry is the warning case).
    let revealed_over = if holdout_open { all } else { positions };
    for p in revealed_over {
        reveal.blind_labels += p.reveal.blind_labels;
        reveal.blind_picks += usize::from(p.reveal.blind_pick);
        let changed = !p.reveal.label_changes.is_empty() || p.reveal.pick_change.is_some();
        for c in &p.reveal.label_changes {
            reveal.labels.push((p.id.clone(), c.clone()));
        }
        if let Some(c) = &p.reveal.pick_change {
            reveal.picks.push((p.id.clone(), c.clone()));
        }
        let e = by_draft.entry(p.draft.as_str()).or_default();
        e.0 |= p.reveal.revealed;
        e.1 |= changed;
    }
    for (draft, (revealed, changed)) in by_draft {
        if revealed {
            reveal.drafts_revealed.push(draft.to_string());
            if !changed {
                reveal.reveals_without_change.push(draft.to_string());
            }
        }
    }

    let lines_at = rule.pick.clone().or_else(|| Some(reference.to_string()));
    let unjudged_lines = lines_at
        .as_deref()
        .and_then(|id| arms.iter().find(|a| a.spec.id == id))
        .map(|a| {
            a.rows
                .iter()
                .filter(|r| r.line == LineState::Unjudged)
                .filter_map(|r| {
                    r.top_line.as_ref().map(|t| UnjudgedLine {
                        position: r.id.clone(),
                        option: t.option_id.clone(),
                        line: t.line.clone(),
                        judgeable: reference_top(&arms, reference, &r.id) == Some(t),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let worklist = Worklist {
        unlabelled_rows: positions
            .iter()
            .filter(|p| !p.unlabelled_rows.is_empty())
            .map(|p| (p.id.clone(), p.unlabelled_rows.clone()))
            .collect(),
        lines_at,
        unjudged_lines,
    };

    let holdout_arms = if holdout_open && !held.is_empty() {
        read_arms(&held, specs, FoldKind::Rule, margin)
    } else {
        Vec::new()
    };
    let state = if held.is_empty() {
        HoldoutState::Empty
    } else if holdout_open {
        HoldoutState::Open(&holdout_arms)
    } else {
        HoldoutState::Sealed
    };
    let weight = weight_read(&arms, reference, DEFAULT_SYNERGY_WEIGHT, state);
    let holdout = (!held.is_empty()).then(|| HoldoutRead {
        positions: held.len(),
        open: holdout_open,
        // The runner lists a position's rows in the order the catalog met them, which follows the
        // arms' rankings: sealed, they go out in option-id order, so the list carries no rank.
        unlabelled_rows: held
            .iter()
            .filter(|p| !p.unlabelled_rows.is_empty())
            .map(|p| {
                let mut rows = p.unlabelled_rows.clone();
                if !holdout_open {
                    rows.sort();
                }
                (p.id.clone(), rows)
            })
            .collect(),
        arms: holdout_arms,
    });

    Read {
        never_everywhere: never_everywhere(&arms),
        fallbacks: Fallbacks {
            labels: positions.iter().map(|p| p.label_fallbacks).sum(),
            picks: positions.iter().filter(|p| p.pick_fallback).count(),
        },
        arms,
        rule,
        sensitivity: Sensitivity {
            margins,
            leave_out,
            margins_readable,
            leave_out_readable,
        },
        second_line,
        r_by_label,
        reveal_changes: reveal,
        worklist,
        weight,
        holdout,
    }
}

// ---- lines ------------------------------------------------------------------------------------------

fn turn_text(champions: &[&str]) -> String {
    let mut ids: Vec<&str> = champions.to_vec();
    ids.sort_unstable();
    ids.join("+")
}

/// A line's canonical text from its turns' champion ids: each turn byte-sorted and `+`-joined, turns
/// joined by ` > `.
pub fn line_text(turns: &[Vec<String>]) -> String {
    turns
        .iter()
        .map(|t| turn_text(&t.iter().map(String::as_str).collect::<Vec<_>>()))
        .collect::<Vec<_>>()
        .join(" > ")
}

/// The same canonical form of a line written as text (a verdict's `line`): robust to a pair written in
/// the other order.
pub fn canonical_line(text: &str) -> String {
    text.split(" > ")
        .map(|turn| turn_text(&turn.split('+').collect::<Vec<_>>()))
        .collect::<Vec<_>>()
        .join(" > ")
}
