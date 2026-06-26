use engine_core::cancellation::CancelHandle;
use engine_core::iterative_deepening::{deepen, SearchResult};
use std::time::Duration;

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
    // completes.
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
fn min_completed_depth_blocks_budget_exceeded_bail() {
    // Depth 1 alone exceeds the entire budget. Default behavior: at top of
    // iter 2, `elapsed >= budget` triggers the immediate return path. With
    // min_completed_depth=2, that bail is also gated until at least depth 2
    // is in `best`.
    let h = CancelHandle::new();
    let result = deepen(
        |depth, _h| {
            std::thread::sleep(Duration::from_millis(20));
            Ok(SearchResult {
                score: depth as f64,
                depth,
                partial: false,
                payload: (),
            })
        },
        5,
        Duration::from_millis(10),
        2,
        &h,
    );
    let r = result.unwrap();
    assert!(
        r.depth >= 2,
        "min_completed_depth=2 forces depth 2 even when budget exceeded; got {}",
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
