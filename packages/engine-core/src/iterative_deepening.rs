use crate::cancellation::{ensure_not_cancelled, CancelError, CancelHandle};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub score: f64,
    pub depth: usize,
    pub partial: bool,
}

pub fn deepen<F>(
    mut search_at_depth: F,
    max_depth: usize,
    budget: Duration,
    cancel: &CancelHandle,
) -> Result<SearchResult, CancelError>
where
    F: FnMut(usize, &CancelHandle) -> Result<SearchResult, CancelError>,
{
    let start = Instant::now();
    let mut best: Option<SearchResult> = None;

    for depth in 1..=max_depth {
        ensure_not_cancelled(cancel)?;

        let elapsed = start.elapsed();
        if elapsed >= budget {
            // Budget exhausted — return what we have, mark partial if we haven't reached max.
            if let Some(mut r) = best.clone() {
                r.partial = depth <= max_depth;
                return Ok(r);
            }
            return Ok(SearchResult { score: 0.0, depth: 0, partial: true });
        }

        let remaining = budget.saturating_sub(elapsed);
        // Heuristic: if next depth probably exceeds remaining (assume ~2x current iter cost),
        // return what we have rather than starting an iteration we can't finish.
        if let Some(prev) = &best {
            let prev_iter_estimate = elapsed / (prev.depth.max(1) as u32);
            if prev_iter_estimate * 2 > remaining {
                let mut r = prev.clone();
                r.partial = true;
                return Ok(r);
            }
        }

        match search_at_depth(depth, cancel) {
            Ok(r) => best = Some(r),
            Err(CancelError::Cancelled) => {
                if let Some(mut r) = best {
                    r.partial = true;
                    return Ok(r);
                }
                return Err(CancelError::Cancelled);
            }
        }
    }

    Ok(best.unwrap_or(SearchResult {
        score: 0.0,
        depth: 0,
        partial: false,
    }))
}
