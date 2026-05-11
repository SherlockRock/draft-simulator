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

pub fn deepen<T, F>(
    mut search_at_depth: F,
    max_depth: usize,
    budget: Duration,
    min_completed_depth: usize,
    cancel: &CancelHandle,
) -> Result<SearchResult<T>, EngineError>
where
    F: FnMut(usize, &CancelHandle) -> Result<SearchResult<T>, EngineError>,
{
    let start = Instant::now();
    let mut best: Option<SearchResult<T>> = None;

    for depth in 1..=max_depth {
        ensure_not_cancelled(cancel)?;

        // `min_completed_depth` is a floor on the bail heuristics: don't return
        // early until at least this depth has completed. Used at root pair-start
        // states (engine.rs) where bailing at depth 1 produces a tree whose
        // pair children all hit the rem=0 terminal — `collect_leaves` then
        // surfaces scenarios that are missing the next decision (e.g. R5 after
        // a B4-B5 pair). The floor is capped by `max_depth`.
        let bail_allowed = best
            .as_ref()
            .is_some_and(|r| r.depth >= min_completed_depth);

        let elapsed = start.elapsed();
        if bail_allowed && elapsed >= budget {
            let mut r = best.take().expect("bail_allowed implies best.is_some()");
            r.partial = true;
            return Ok(r);
        }

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

        match search_at_depth(depth, cancel) {
            Ok(r) => best = Some(r),
            Err(EngineError::Cancelled) => {
                if let Some(mut r) = best.take() {
                    r.partial = true;
                    return Ok(r);
                }
                return Err(EngineError::Cancelled);
            }
            Err(other) => return Err(other),
        }
    }

    best.ok_or_else(|| EngineError::Internal("iterative deepening ran with max_depth=0".into()))
}
