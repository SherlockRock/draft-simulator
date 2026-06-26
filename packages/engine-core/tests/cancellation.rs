use engine_core::cancellation::{ensure_not_cancelled, CancelError, CancelHandle};

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
