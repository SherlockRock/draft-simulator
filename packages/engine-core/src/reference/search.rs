//! The reference search (design docs/designs/engine-reference-search-design.md § 3; R3, R4, R6, R8):
//! iterative-deepening alpha-beta on the Blue-perspective D3 value. Every ROOT child is searched with a
//! full window, so every root value is exact and the ranked list can be compared to the oracle's; interior
//! nodes prune with static move ordering and memoise exact values in the transposition table. Depth
//! iteration, node budget, deadline, cancel and per-depth partials go through the incumbent's
//! `iterative_deepening::deepen_with_hook` and `cancellation::CancelHandle`, unchanged — the target note's
//! § 2 contract, met by reuse.

use super::feasibility::{side_feasible, FeasibilityMemo, FeasibilityRule};
use super::node::{classify, legal_actions_under, ClassifyError, LeafEnd, LeafKind, NodeKind};
use super::objective::Leaf;
use super::oracle::{Mode, OracleError, OracleInput};
use super::state::{Action, Position};
use super::transposition::{Entry, Key, TranspositionTable};
use crate::cancellation::{ensure_not_cancelled, CancelHandle};
use crate::draft_state::{ActionType, Side};
use crate::engine::EngineError;
use crate::iterative_deepening::{deepen_with_hook, SearchResult};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct SearchParams {
    /// Cumulative across iterations (the same quantity as `Progress.nodes`): the iteration that pushes the
    /// total past it is cut and the previous depth is returned `partial`.
    pub node_budget: Option<u64>,
    /// `false`: no cutoffs. Must reproduce the oracle's node and leaf counts (with the table off).
    pub prune: bool,
    /// `false`: no transposition table.
    pub transposition: bool,
    /// Handed to `deepen_with_hook` as its wall-clock budget. Its two time-based stop paths (budget spent,
    /// the 2× cost heuristic) are reachable only if an iteration takes a third of this; the tests pass a day.
    pub wall_budget: Duration,
    /// `deepen_with_hook`'s floor on the bail heuristic.
    pub min_completed_depth: usize,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            node_budget: None,
            prune: true,
            transposition: true,
            wall_budget: Duration::from_secs(86_400),
            min_completed_depth: 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RankedAction {
    pub action: Action,
    /// Exact, Blue-perspective (as `Evaluation::value`).
    pub value: f64,
    /// The principal variation below `action`: the mover-best action at every node down to the leaf.
    pub continuation: Vec<Action>,
    /// How the replayed continuation ends — the S11 guard: a continuation ending with a side (or both)
    /// infeasible says so here.
    pub ends: LeafEnd,
}

impl RankedAction {
    /// The S11 guard: the mover's own side cannot complete five roles at the end of this line. A line
    /// that breaks only the opponent is a denial, not a defect.
    pub fn breaks_mover(&self, mover: Side) -> bool {
        !match mover {
            Side::Blue => self.ends.blue_feasible,
            Side::Red => self.ends.red_feasible,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchOutcome {
    pub mover: Side,
    /// The completed depth the ranking comes from.
    pub depth: usize,
    /// A deeper iteration was cut by the node budget, the deadline, or a cancel that arrived INSIDE an
    /// iteration. A cancel that arrives between iterations is `Err(Cancelled)` (the driver's contract).
    pub partial: bool,
    pub value: f64,
    /// Best-first for the mover; ties in canonical order (as the oracle).
    pub ranked: Vec<RankedAction>,
    /// Within `epsilon` of the best, canonical order (as the oracle).
    pub top_set: Vec<Action>,
    /// This depth's iteration alone, with the oracle's definitions: `nodes` = positions visited below the
    /// root, `leaves` = objective calls at leaves. `orderings` = objective calls spent ordering children;
    /// `table_hits` = lookups answered from the table during this iteration.
    pub nodes: u64,
    pub leaves: u64,
    pub orderings: u64,
    pub cutoffs: u64,
    pub table_hits: u64,
    /// Every iteration so far — what `node_budget` is measured against.
    pub nodes_total: u64,
    /// Table lookups answered over the whole search (the table lives across iterations).
    pub table_hits_total: u64,
    /// Entries in the table after this iteration.
    pub table_entries: u64,
    pub elapsed: Duration,
}

/// The iteration ceiling: `Horizon(h)` → `min(h, turns_remaining)`; `FullRemainder` → `turns_remaining`.
pub fn max_depth_for(input: &OracleInput<'_>) -> usize {
    let remaining = input
        .position
        .format()
        .turns_remaining(input.position.slot_index());
    match input.mode {
        Mode::FullRemainder => remaining,
        Mode::Horizon(h) => h.min(remaining),
    }
}

fn invalid(err: impl std::fmt::Display) -> EngineError {
    EngineError::InvalidInput {
        path: vec![err.to_string()],
    }
}

/// Shared across iterations of one `search` call.
struct Shared {
    memo: FeasibilityMemo,
    table: TranspositionTable,
    nodes_total: u64,
}

/// One iteration at `depth`. Two lifetimes on purpose: `'i` is this iteration's borrows (the driver's
/// per-iteration cancel handle, the shared state), `'a` is the caller's input.
struct Iteration<'i, 'a> {
    input: &'i OracleInput<'a>,
    params: &'i SearchParams,
    cancel: &'i CancelHandle,
    depth: usize,
    shared: &'i mut Shared,
    nodes: u64,
    leaves: u64,
    orderings: u64,
    cutoffs: u64,
    table_hits: u64,
}

impl Iteration<'_, '_> {
    fn classify(
        &mut self,
        position: &Position<'_>,
        turns_used: usize,
    ) -> Result<NodeKind, EngineError> {
        classify(
            position,
            turns_used,
            Some(self.depth),
            self.input.universe,
            self.input.pools,
            self.input.feasibility,
            &mut self.shared.memo,
        )
        .map_err(|e: ClassifyError| invalid(e))
    }

    fn leaf_value(&self, position: &Position<'_>, end: LeafEnd) -> f64 {
        self.input.objective.value_under(
            &Leaf {
                blue: position.picks(Side::Blue),
                red: position.picks(Side::Red),
                blue_feasible: end.blue_feasible,
                red_feasible: end.red_feasible,
            },
            self.input.feasibility,
            end.blue_off_pool,
            end.red_off_pool,
        )
    }

    /// R4: children by the static utility of the child position, best first for the mover; equal values
    /// keep canonical order. Bans have no term (D3 iii), so a ban slot's children are all equal: they are
    /// returned in canonical order without evaluating anything.
    fn order(
        &mut self,
        position: &Position<'_>,
        slot_side: Side,
        slot_action: ActionType,
        actions: Vec<Action>,
    ) -> Vec<Action> {
        if slot_action == ActionType::Ban {
            return actions;
        }
        let mut keyed: Vec<(f64, Action)> = actions
            .into_iter()
            .map(|a| {
                self.orderings += 1;
                let child = position.apply(a);
                let v = self.input.objective.value(&Leaf {
                    blue: child.picks(Side::Blue),
                    red: child.picks(Side::Red),
                    blue_feasible: true,
                    red_feasible: true,
                });
                (v, a)
            })
            .collect();
        keyed.sort_by(|x, y| {
            let by_value = match slot_side {
                Side::Blue => y.0.partial_cmp(&x.0),
                Side::Red => x.0.partial_cmp(&y.0),
            };
            by_value
                .expect("objective values are finite (Objective contract)")
                .then(x.1.cmp(&y.1))
        });
        keyed.into_iter().map(|(_, a)| a).collect()
    }

    /// Alpha-beta value of `position` and its principal continuation. `turns_used` turns below the root.
    /// Fail-soft: the returned value is exact iff it lies strictly inside `(alpha0, beta0)`; only then is it
    /// stored. The continuation is the line through the child `best` currently holds — the LAST child that
    /// strictly improved it — which is exact whenever the node's value is (it was strictly inside the
    /// window it was searched with, or it could not have improved `best` strictly inside this one).
    fn value(
        &mut self,
        position: &Position<'_>,
        turns_used: usize,
        alpha0: f64,
        beta0: f64,
    ) -> Result<(f64, Vec<Action>), EngineError> {
        self.nodes += 1;
        self.shared.nodes_total += 1;
        self.cancel.count_node();
        ensure_not_cancelled(self.cancel)?;
        if let Some(budget) = self.params.node_budget {
            if self.shared.nodes_total > budget {
                return Err(EngineError::Timeout(self.depth));
            }
        }
        let (slot, actions) = match self.classify(position, turns_used)? {
            NodeKind::Leaf(end) => {
                self.leaves += 1;
                return Ok((self.leaf_value(position, end), Vec::new()));
            }
            NodeKind::Interior { slot, actions } => (slot, actions),
        };
        let key = self
            .params
            .transposition
            .then(|| Key::of(position, self.depth - turns_used));
        if let Some(key) = &key {
            if let Some(entry) = self.shared.table.get(key) {
                self.table_hits += 1;
                return Ok((entry.value, entry.continuation.clone()));
            }
        }
        let ordered = self.order(position, slot.side, slot.action, actions);
        let (mut alpha, mut beta) = (alpha0, beta0);
        let mut best: Option<(f64, Vec<Action>)> = None;
        for action in ordered {
            let child = position.apply(action);
            let (v, pv) = self.value(&child, turns_used + 1, alpha, beta)?;
            let improves = match &best {
                None => true,
                Some((b, _)) => match slot.side {
                    Side::Blue => v > *b,
                    Side::Red => v < *b,
                },
            };
            if improves {
                let mut line = Vec::with_capacity(pv.len() + 1);
                line.push(action);
                line.extend(pv);
                best = Some((v, line));
            }
            match slot.side {
                Side::Blue => alpha = alpha.max(v),
                Side::Red => beta = beta.min(v),
            }
            if self.params.prune && alpha >= beta {
                self.cutoffs += 1;
                break;
            }
        }
        let (v, pv) = best.expect("Interior carries at least one action");
        if let Some(key) = key {
            self.shared.table.store_if_exact(
                key,
                Entry {
                    value: v,
                    continuation: pv.clone(),
                },
                alpha0,
                beta0,
            );
        }
        Ok((v, pv))
    }

    /// R8: replay `action ++ continuation` from the root through `classify`, so the reported ending and the
    /// leaf's value are computed from the game, not read out of the search. A continuation that does not
    /// follow legal interior nodes to a leaf is a programming error.
    fn replay(
        &mut self,
        root: &Position<'_>,
        action: Action,
        continuation: &[Action],
    ) -> Result<(LeafEnd, f64), EngineError> {
        let mut position = root.apply(action);
        let mut turns_used = 1;
        for a in continuation {
            match self.classify(&position, turns_used)? {
                NodeKind::Interior { actions, .. } if actions.contains(a) => {}
                other => {
                    return Err(EngineError::Internal(format!(
                        "principal continuation step {a:?} is not a legal interior move (node was {other:?})"
                    )))
                }
            }
            position = position.apply(*a);
            turns_used += 1;
        }
        match self.classify(&position, turns_used)? {
            NodeKind::Leaf(end) => Ok((end, self.leaf_value(&position, end))),
            NodeKind::Interior { .. } => Err(EngineError::Internal(
                "principal continuation ends before a leaf".into(),
            )),
        }
    }

    fn run(mut self) -> Result<SearchOutcome, EngineError> {
        let root = self.input.position;
        let (slot, actions) = match self.classify(root, 0)? {
            NodeKind::Interior { slot, actions } => (slot, actions),
            // Unreachable: `search` checks the root before deepening. Named anyway so a lie is impossible.
            NodeKind::Leaf(end) => {
                return Err(invalid(match end.kind {
                    LeafKind::Complete => OracleError::DraftComplete,
                    LeafKind::DryPool => OracleError::NoLegalAction {
                        slot: root.slot_index(),
                    },
                    LeafKind::Horizon => OracleError::HorizonZero,
                }))
            }
        };
        // Root children are searched with a full window each, so their order changes no value and no ranking.
        // With the table off it changes no count either; with the table on it decides which subtree populates
        // the table first, so node, cutoff and hit counts are root-order dependent while values are not.
        let ordered = self.order(root, slot.side, slot.action, actions);
        let mut ranked = Vec::with_capacity(ordered.len());
        for action in ordered {
            let child = root.apply(action);
            let (value, continuation) = self.value(&child, 1, f64::NEG_INFINITY, f64::INFINITY)?;
            let (ends, replayed) = self.replay(root, action, &continuation)?;
            debug_assert_eq!(
                replayed, value,
                "the principal continuation must reproduce its value"
            );
            ranked.push(RankedAction {
                action,
                value,
                continuation,
                ends,
            });
        }
        ranked.sort_by(|x, y| {
            let by_value = match slot.side {
                Side::Blue => y.value.partial_cmp(&x.value),
                Side::Red => x.value.partial_cmp(&y.value),
            };
            by_value
                .expect("root values are finite")
                .then(x.action.cmp(&y.action))
        });
        let value = ranked[0].value;
        let mut top_set: Vec<Action> = ranked
            .iter()
            .filter(|r| (r.value - value).abs() <= self.input.epsilon)
            .map(|r| r.action)
            .collect();
        top_set.sort();
        Ok(SearchOutcome {
            mover: slot.side,
            depth: self.depth,
            partial: false,
            value,
            ranked,
            top_set,
            nodes: self.nodes,
            leaves: self.leaves,
            orderings: self.orderings,
            cutoffs: self.cutoffs,
            table_hits: self.table_hits,
            nodes_total: self.shared.nodes_total,
            table_hits_total: self.shared.table.hits(),
            table_entries: u64::try_from(self.shared.table.len()).unwrap_or(u64::MAX),
            elapsed: Duration::ZERO,
        })
    }
}

/// Root checks (the oracle's, as `InvalidInput`), then iterative deepening to `max_depth_for(input)`.
/// `on_depth` fires with each completed depth that is followed by a deeper one (`deepen_with_hook`'s
/// contract); the returned outcome carries `partial`/`depth` from the driver.
pub fn search(
    input: &OracleInput<'_>,
    params: &SearchParams,
    cancel: &CancelHandle,
    mut on_depth: impl FnMut(&SearchOutcome),
) -> Result<SearchOutcome, EngineError> {
    let started = Instant::now();
    let position = input.position;
    if position.next_slot().is_none() {
        return Err(invalid(OracleError::DraftComplete));
    }
    if input.mode == Mode::Horizon(0) {
        return Err(invalid(OracleError::HorizonZero));
    }
    let mut shared = Shared {
        memo: FeasibilityMemo::default(),
        table: TranspositionTable::default(),
        nodes_total: 0,
    };
    let feasible = |memo: &mut FeasibilityMemo, side| {
        side_feasible(
            memo,
            input.feasibility,
            side,
            position,
            input.pools,
            input.universe,
        )
    };
    let (blue_feasible, red_feasible) = (
        feasible(&mut shared.memo, Side::Blue),
        feasible(&mut shared.memo, Side::Red),
    );
    // The gate refuses a root a side cannot finish from (slice 4, R3). Under the live rule (U10)
    // only locked picks that cannot fill five roles are infeasible — a fact on the board, often the
    // OPPONENT's (a pair of two ADC-only champions), and the draft goes on: that side is priced at L'
    // on every leaf, a constant, so the ranking is the board's and the off-pool term's (round 5).
    if input.feasibility != FeasibilityRule::PoolOrRoster && !(blue_feasible && red_feasible) {
        return Err(invalid(OracleError::RootInfeasible {
            blue_feasible,
            red_feasible,
        }));
    }
    if legal_actions_under(
        position,
        input.universe,
        input.pools,
        input.feasibility,
        &mut shared.memo,
    )
    .is_empty()
    {
        return Err(invalid(OracleError::NoLegalAction {
            slot: position.slot_index(),
        }));
    }
    let max_depth = max_depth_for(input);
    let result = deepen_with_hook(
        |depth, handle| {
            let outcome = Iteration {
                input,
                params,
                cancel: handle,
                depth,
                shared: &mut shared,
                nodes: 0,
                leaves: 0,
                orderings: 0,
                cutoffs: 0,
                table_hits: 0,
            }
            .run()?;
            Ok(SearchResult {
                score: outcome.value,
                depth,
                partial: false,
                payload: outcome,
            })
        },
        max_depth,
        params.wall_budget,
        params.min_completed_depth,
        cancel,
        |r| on_depth(&r.payload),
    )?;
    let mut outcome = result.payload;
    outcome.depth = result.depth;
    outcome.partial = result.partial;
    outcome.elapsed = started.elapsed();
    Ok(outcome)
}
