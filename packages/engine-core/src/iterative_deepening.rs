use crate::cancellation::{ensure_not_cancelled, CancelHandle};
use crate::engine::EngineError;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct SearchResult<T> {
    pub score: f64,
    pub depth: usize,
    pub partial: bool,
    pub payload: T,
}

/// Iterative deepening under a wall-clock `budget`.
///
/// Three stop sources, in the order they are consulted at the top of each
/// iteration:
///
/// 1. **External cancel** on `cancel` → `Err(Cancelled)` (the backend swallows
///    it; a best-so-far is deliberately not returned here — see `engine.rs`,
///    which derives `cancelled` from the handle so a mid-iteration cancel with
///    a best-so-far is also swallowed).
/// 2. **Budget spent** (`elapsed >= budget`) with a completed depth in hand →
///    that depth, `partial: true`. `min_completed_depth` does NOT override
///    this: the floor gates the bail *heuristics*, it does not extend the
///    budget (slot 6's depth 2 ran 6+ minutes when it did).
/// 3. The 2× **cost heuristic**, gated by the floor: don't start an iteration
///    that will probably overrun.
///
/// Because the heuristic under-predicts when the next ply is much costlier
/// than the last (two consecutive pair turns), every iteration after the
/// first runs under a deadline-bearing clone of `cancel`
/// (`CancelHandle::with_deadline`). A wake point inside `search_at_depth`
/// then fails with `EngineError::Timeout`, and the last completed depth is
/// returned as `partial: true`. The first iteration is exempt: a caller
/// always gets a tree, and a late depth 1 beats a Timeout error.
pub fn deepen<T, F>(
    search_at_depth: F,
    max_depth: usize,
    budget: Duration,
    min_completed_depth: usize,
    cancel: &CancelHandle,
) -> Result<SearchResult<T>, EngineError>
where
    F: FnMut(usize, &CancelHandle) -> Result<SearchResult<T>, EngineError>,
{
    deepen_with_hook(search_at_depth, max_depth, budget, min_completed_depth, cancel, |_| {})
}

/// `deepen` with a per-depth hook (engine target § 2: partial results while
/// computing). `on_depth` fires at the top of the loop body, only once the
/// three stop checks have decided to run ANOTHER iteration, with the previous
/// depth's result — so it fires once per completed depth that is followed by
/// a deeper one and never for the depth that becomes the return value. A
/// partial therefore always means "this depth is done and a deeper one is now
/// running". `cancel.depth_in_progress` is set at the same point.
pub fn deepen_with_hook<T, F, H>(
    mut search_at_depth: F,
    max_depth: usize,
    budget: Duration,
    min_completed_depth: usize,
    cancel: &CancelHandle,
    mut on_depth: H,
) -> Result<SearchResult<T>, EngineError>
where
    F: FnMut(usize, &CancelHandle) -> Result<SearchResult<T>, EngineError>,
    H: FnMut(&SearchResult<T>),
{
    let start = Instant::now();
    let deadline = start + budget;
    let mut best: Option<SearchResult<T>> = None;

    for depth in 1..=max_depth {
        // `cancel` carries no deadline of its own, so this is the external
        // flag only.
        ensure_not_cancelled(cancel)?;

        let elapsed = start.elapsed();
        if best.is_some() && elapsed >= budget {
            let mut r = best.take().expect("guarded by is_some");
            r.partial = true;
            return Ok(r);
        }

        // `min_completed_depth` is a floor on the bail heuristic: don't return
        // early until at least this depth has completed. Used at root pair-start
        // states (engine.rs) where bailing at depth 1 produces a tree whose
        // pair children all hit the rem=0 terminal — `collect_leaves` then
        // surfaces scenarios that are missing the next decision (e.g. R5 after
        // a B4-B5 pair). The floor is capped by `max_depth`.
        let bail_allowed = best
            .as_ref()
            .is_some_and(|r| r.depth >= min_completed_depth);

        let remaining = budget.saturating_sub(elapsed);
        // Heuristic: if next depth probably exceeds remaining (assume ~2x current iter cost),
        // return what we have rather than starting an iteration we can't finish.
        if bail_allowed {
            if let Some(prev) = &best {
                let prev_iter_estimate = elapsed / (prev.depth.max(1) as u32);
                if prev_iter_estimate * 2 > remaining {
                    let mut r = best.take().expect("bail_allowed implies best.is_some()");
                    r.partial = true;
                    return Ok(r);
                }
            }
        }

        if let Some(prev) = &best {
            on_depth(prev);
        }
        cancel.set_depth_in_progress(depth);

        let handle = if best.is_some() {
            cancel.with_deadline(deadline)
        } else {
            cancel.clone()
        };

        match search_at_depth(depth, &handle) {
            Ok(r) => best = Some(r),
            Err(EngineError::Cancelled) => {
                if let Some(mut r) = best.take() {
                    r.partial = true;
                    return Ok(r);
                }
                return Err(EngineError::Cancelled);
            }
            Err(EngineError::Timeout(_)) => {
                if let Some(mut r) = best.take() {
                    r.partial = true;
                    return Ok(r);
                }
                // Unreachable while the first iteration runs without a
                // deadline; kept so a future caller-supplied deadline still
                // has a well-formed outcome.
                return Err(EngineError::Timeout(depth));
            }
            Err(other) => return Err(other),
        }
    }

    best.ok_or_else(|| EngineError::Internal("iterative deepening ran with max_depth=0".into()))
}
