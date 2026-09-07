use engine_core::cancellation::{ensure_not_cancelled, CancelError, CancelHandle};
use std::time::{Duration, Instant};

#[test]
fn handle_starts_uncancelled() {
    let h = CancelHandle::new();
    assert!(!h.is_cancelled());
}

#[test]
fn cancel_sets_flag() {
    let h = CancelHandle::new();
    h.cancel();
    assert!(h.is_cancelled());
}

#[test]
fn ensure_not_cancelled_returns_err_when_cancelled() {
    let h = CancelHandle::new();
    h.cancel();
    let result = ensure_not_cancelled(&h);
    assert!(matches!(result, Err(CancelError::Cancelled)));
}

#[test]
fn cancel_visible_across_clones() {
    let h = CancelHandle::new();
    let h2 = h.clone();
    h.cancel();
    assert!(h2.is_cancelled());
}

// ---- Deadline (compute-local) ---------------------------------------------
//
// A deadline is attached to a clone of the handle by `with_deadline`; the
// clone shares the external flag. `is_cancelled` stays "external cancel only"
// (engine.rs derives `meta.cancelled` from it, and the backend swallows a
// cancelled response), while `should_stop` / `ensure_not_cancelled` also
// consult the clock so a wake point inside an iteration stops on either.

#[test]
fn a_passed_deadline_stops_the_search_without_tripping_is_cancelled() {
    let h = CancelHandle::new().with_deadline(Instant::now() - Duration::from_millis(1));
    assert!(h.should_stop(), "a passed deadline is a stop signal");
    assert!(
        !h.is_cancelled(),
        "the deadline must not read as an external cancel"
    );
    assert!(matches!(
        ensure_not_cancelled(&h),
        Err(CancelError::DeadlineExceeded)
    ));
}

#[test]
fn a_future_deadline_does_not_stop_the_search() {
    let h = CancelHandle::new().with_deadline(Instant::now() + Duration::from_secs(60));
    assert!(!h.should_stop());
    assert!(ensure_not_cancelled(&h).is_ok());
}

#[test]
fn the_deadline_clone_shares_the_external_flag_both_ways() {
    let outer = CancelHandle::new();
    let inner = outer.with_deadline(Instant::now() + Duration::from_secs(60));
    outer.cancel();
    assert!(inner.is_cancelled(), "cancel on the outer handle reaches the clone");
    assert!(
        matches!(ensure_not_cancelled(&inner), Err(CancelError::Cancelled)),
        "an external cancel wins over an unexpired deadline"
    );
    assert!(
        outer.deadline().is_none(),
        "the outer handle carries no deadline of its own"
    );
}
