use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Cooperative stop signal threaded through the search.
///
/// Two independent sources, kept distinct because the backend treats them
/// differently (`navigatorEngine.js`: a `cancelled` response is swallowed, a
/// partial one is persisted and broadcast):
///
/// - the **external flag** (`cancel()` / `is_cancelled()`), shared by every
///   clone — supersession by a newer compute, or shutdown;
/// - an optional **deadline**, attached to a clone by `with_deadline` and
///   local to that clone. `iterative_deepening::deepen` gives each iteration
///   after the first a deadline-bearing clone so a wake point inside an
///   iteration stops on the clock as well as on the flag.
///
/// `is_cancelled` reads the flag only; `should_stop` / `ensure_not_cancelled`
/// read both, with the flag taking precedence.
#[derive(Clone, Debug)]
pub struct CancelHandle {
    flag: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl CancelHandle {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            deadline: None,
        }
    }

    /// A clone sharing this handle's external flag, with `deadline` attached.
    /// The receiver is unchanged.
    pub fn with_deadline(&self, deadline: Instant) -> Self {
        Self {
            flag: Arc::clone(&self.flag),
            deadline: Some(deadline),
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }

    /// External cancel only. Does NOT consult the deadline.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    pub fn deadline_passed(&self) -> bool {
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }

    /// Either stop source. Wake points inside the search use this (or
    /// `ensure_not_cancelled`, which also says which one fired).
    pub fn should_stop(&self) -> bool {
        self.is_cancelled() || self.deadline_passed()
    }
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CancelError {
    #[error("compute cancelled")]
    Cancelled,
    #[error("compute deadline exceeded")]
    DeadlineExceeded,
}

/// The external flag wins over the deadline: a superseded compute must report
/// `Cancelled` even if its deadline has also passed.
#[inline]
pub fn ensure_not_cancelled(h: &CancelHandle) -> Result<(), CancelError> {
    if h.is_cancelled() {
        Err(CancelError::Cancelled)
    } else if h.deadline_passed() {
        Err(CancelError::DeadlineExceeded)
    } else {
        Ok(())
    }
}
