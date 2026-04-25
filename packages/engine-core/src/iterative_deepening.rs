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
    cancel: &CancelHandle,
) -> Result<SearchResult<T>, EngineError>
where
    F: FnMut(usize, &CancelHandle) -> Result<SearchResult<T>, EngineError>,
{
    let start = Instant::now();
    let mut best: Option<SearchResult<T>> = None;

    for depth in 1..=max_depth {
        ensure_not_cancelled(cancel)?;

        let elapsed = start.elapsed();
        if best.is_some() && elapsed >= budget {
            let mut r = best.take().expect("guarded by best.is_some()");
            r.partial = true;
            return Ok(r);
        }

        let remaining = budget.saturating_sub(elapsed);
        // Heuristic: if next depth probably exceeds remaining (assume ~2x current iter cost),
        // return what we have rather than starting an iteration we can't finish.
        if let Some(prev) = &best {
            let prev_iter_estimate = elapsed / (prev.depth.max(1) as u32);
            if prev_iter_estimate * 2 > remaining {
                let mut r = best.take().expect("guarded by best.is_some()");
                r.partial = true;
                return Ok(r);
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
