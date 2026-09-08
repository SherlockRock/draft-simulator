use engine_core::cancellation::{ensure_not_cancelled, CancelHandle};
use engine_core::engine::EngineError;
use engine_core::iterative_deepening::{deepen, deepen_with_hook, SearchResult};
use std::time::{Duration, Instant};

#[test]
fn returns_deepest_within_budget() {
    let h = CancelHandle::new();
    let result = deepen(
        |depth, _h| {
            std::thread::sleep(Duration::from_millis(10));
            Ok(SearchResult {
                score: depth as f64,
                depth,
                partial: false,
                payload: (),
            })
        },
        4,
        Duration::from_millis(100),
        1,
        &h,
    );
    assert!(result.is_ok());
    let r = result.unwrap();
    assert!(r.depth >= 1, "must complete at least depth 1");
}

#[test]
fn returns_partial_on_budget_exceed() {
    let h = CancelHandle::new();
    let result = deepen(
        |depth, _h| {
            std::thread::sleep(Duration::from_millis(50));
            Ok(SearchResult {
                score: depth as f64,
                depth,
                partial: false,
                payload: (),
            })
        },
        10,
        Duration::from_millis(75),
        1,
        &h,
    );
    let r = result.unwrap();
    assert!(r.depth < 10, "must not complete all 10 depths in 75ms");
    assert!(r.depth >= 1, "must complete at least depth 1");
}

#[test]
fn min_completed_depth_blocks_heuristic_bail() {
    // Depth 1 takes 50ms with a 100ms budget. Default behavior: after depth 1
    // completes (elapsed=50, remaining=50), the prev_iter_estimate*2 heuristic
    // (50*2=100 > 50) would bail before starting depth 2 → r.depth == 1.
    // With min_completed_depth=2, the heuristic is suppressed until depth 2
    // completes. (The closure ignores its handle, so the in-iteration
    // deadline cannot cut depth 2 here — this isolates the heuristic gate.)
    let h = CancelHandle::new();
    let result = deepen(
        |depth, _h| {
            std::thread::sleep(Duration::from_millis(50));
            Ok(SearchResult {
                score: depth as f64,
                depth,
                partial: false,
                payload: (),
            })
        },
        5,
        Duration::from_millis(100),
        2,
        &h,
    );
    let r = result.unwrap();
    assert!(
        r.depth >= 2,
        "min_completed_depth=2 must force depth 2; got {}",
        r.depth
    );
}

#[test]
fn min_completed_depth_does_not_extend_beyond_max_depth() {
    // If max_depth=1 and min_completed_depth=2, the loop still terminates at
    // max_depth=1 (the for-loop bound is the hard cap). min_completed_depth
    // is a floor on the bail heuristics, not on max_depth.
    let h = CancelHandle::new();
    let result = deepen(
        |depth, _h| {
            std::thread::sleep(Duration::from_millis(5));
            Ok(SearchResult {
                score: depth as f64,
                depth,
                partial: false,
                payload: (),
            })
        },
        1,
        Duration::from_millis(1000),
        2,
        &h,
    );
    let r = result.unwrap();
    assert_eq!(r.depth, 1, "max_depth=1 caps depth even if min_completed_depth=2");
}

// ---- Deadline inside an iteration ------------------------------------------
//
// `deepen` hands each iteration after the first a handle carrying the budget
// deadline. A cooperative `search_at_depth` (one that checks the handle at its
// wake points) is cut mid-iteration and the last COMPLETED depth comes back as
// `partial: true`. The first iteration is exempt so a caller always gets a
// tree (a Timeout error is strictly less useful than a late depth 1).

/// An iteration costing `cost_ms(depth)` that checks the handle every 1 ms.
fn cooperative(
    cost_ms: impl Fn(usize) -> u64,
) -> impl FnMut(usize, &CancelHandle) -> Result<SearchResult<usize>, EngineError> {
    move |depth, h| {
        let end = Instant::now() + Duration::from_millis(cost_ms(depth));
        while Instant::now() < end {
            ensure_not_cancelled(h)?;
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(SearchResult {
            score: depth as f64,
            depth,
            partial: false,
            payload: depth,
        })
    }
}

#[test]
fn an_under_predicted_iteration_is_cut_at_the_deadline_and_the_prior_depth_returned() {
    // Depth 1 = 10 ms, depth 2 = 400 ms, budget 40 ms. After depth 1 the 2×
    // heuristic (est. 20 ms ≤ 30 ms remaining) STARTS depth 2 — the slot-6
    // shape, where the next pair ply costs far more than twice the last.
    let h = CancelHandle::new();
    let t0 = Instant::now();
    let r = deepen(
        cooperative(|d| if d == 1 { 10 } else { 400 }),
        5,
        Duration::from_millis(40),
        1,
        &h,
    )
    .expect("deadline yields a partial, not an error");
    assert_eq!(r.depth, 1, "the last completed depth comes back");
    assert!(r.partial, "a deadline-cut result is partial");
    assert!(
        t0.elapsed() < Duration::from_millis(200),
        "the deadline was honoured inside the iteration, elapsed {:?}",
        t0.elapsed()
    );
    assert!(!h.is_cancelled(), "a deadline never trips the external flag");
}

#[test]
fn the_min_completed_depth_floor_yields_to_the_deadline() {
    // Floor 2 suppresses the between-iteration bails, so depth 2 starts even
    // though the budget is nearly spent; the deadline still cuts it.
    let h = CancelHandle::new();
    let t0 = Instant::now();
    let r = deepen(
        cooperative(|d| if d == 1 { 10 } else { 400 }),
        5,
        Duration::from_millis(15),
        2,
        &h,
    )
    .expect("deadline yields a partial, not an error");
    assert_eq!(r.depth, 1);
    assert!(r.partial);
    assert!(
        t0.elapsed() < Duration::from_millis(200),
        "elapsed {:?}",
        t0.elapsed()
    );
}

#[test]
fn the_first_depth_always_completes_even_past_the_deadline() {
    let h = CancelHandle::new();
    let r = deepen(cooperative(|_| 40), 3, Duration::from_millis(5), 1, &h)
        .expect("depth 1 is exempt from the deadline");
    assert_eq!(r.depth, 1);
    assert!(r.partial, "later depths were skipped, so the result is partial");
}

#[test]
fn an_external_cancel_mid_first_iteration_is_still_cancelled() {
    let h = CancelHandle::new();
    let canceller = h.clone();
    let r = deepen(
        move |depth, handle| {
            canceller.cancel();
            ensure_not_cancelled(handle)?;
            Ok(SearchResult {
                score: 0.0,
                depth,
                partial: false,
                payload: (),
            })
        },
        3,
        Duration::from_secs(5),
        1,
        &h,
    );
    assert!(matches!(r, Err(EngineError::Cancelled)));
}

// ---- deepen_with_hook tests -----------------------------------------------

#[test]
fn hook_fires_once_per_completed_depth_that_is_followed_by_another() {
    let h = CancelHandle::new();
    let mut seen = Vec::new();
    let r = deepen_with_hook(
        cooperative(|_| 5),
        3,
        Duration::from_secs(10),
        1,
        &h,
        |res: &SearchResult<usize>| seen.push(res.depth),
    )
    .unwrap();
    assert_eq!(r.depth, 3);
    assert!(!r.partial);
    assert_eq!(seen, vec![1, 2], "depth 3 is the return value, never a partial");
}

#[test]
fn hook_does_not_fire_when_the_heuristic_bails_after_depth_one() {
    // Depth 1 = 30 ms, budget 45 ms: est. 60 ms for depth 2 > 15 ms remaining → bail.
    let h = CancelHandle::new();
    let mut seen = Vec::new();
    let r = deepen_with_hook(
        cooperative(|_| 30),
        5,
        Duration::from_millis(45),
        1,
        &h,
        |res: &SearchResult<usize>| seen.push(res.depth),
    )
    .unwrap();
    assert_eq!(r.depth, 1);
    assert!(r.partial);
    assert!(seen.is_empty(), "the returned depth is not a partial");
}

#[test]
fn hook_fires_for_the_depth_before_a_deadline_cut_iteration() {
    // Slot-6 shape: depth 1 = 10 ms, depth 2 = 400 ms, budget 40 ms → depth 2 starts and is cut.
    let h = CancelHandle::new();
    let mut seen = Vec::new();
    let r = deepen_with_hook(
        cooperative(|d| if d == 1 { 10 } else { 400 }),
        5,
        Duration::from_millis(40),
        1,
        &h,
        |res: &SearchResult<usize>| seen.push(res.depth),
    )
    .unwrap();
    assert_eq!(r.depth, 1);
    assert!(r.partial);
    assert_eq!(seen, vec![1]);
}

#[test]
fn hook_never_fires_on_an_external_cancel_before_the_first_depth() {
    let h = CancelHandle::new();
    h.cancel();
    let mut seen = Vec::new();
    let r = deepen_with_hook(
        cooperative(|_| 5),
        3,
        Duration::from_secs(1),
        1,
        &h,
        |res: &SearchResult<usize>| seen.push(res.depth),
    );
    assert!(matches!(r, Err(EngineError::Cancelled)));
    assert!(seen.is_empty());
}

#[test]
fn depth_in_progress_is_the_depth_now_running() {
    let h = CancelHandle::new();
    let observed = std::cell::RefCell::new(Vec::new());
    let r = deepen_with_hook(
        |depth, handle| {
            observed.borrow_mut().push(handle.depth_in_progress());
            Ok(SearchResult {
                score: depth as f64,
                depth,
                partial: false,
                payload: depth,
            })
        },
        3,
        Duration::from_secs(10),
        1,
        &h,
        |_: &SearchResult<usize>| {},
    )
    .unwrap();
    assert_eq!(r.depth, 3);
    assert_eq!(*observed.borrow(), vec![1, 2, 3]);
    assert_eq!(h.depth_in_progress(), 3, "left at the last depth that ran");
}
