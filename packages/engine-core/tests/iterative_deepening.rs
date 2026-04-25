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
        &h,
    );
    let r = result.unwrap();
    assert!(r.depth < 10, "must not complete all 10 depths in 75ms");
    assert!(r.depth >= 1, "must complete at least depth 1");
}
