use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Live counters a caller may sample while a search runs (engine target § 2
/// heartbeat: depth in progress, nodes). Shared by every clone of a handle,
/// including deadline-bearing clones. Nothing inside engine-core reads them.
#[derive(Debug, Default)]
pub struct Progress {
    /// Internal expansions so far — the running form of
    /// `SearchStats.nodes_evaluated`, cumulative across iterations.
    pub nodes: AtomicUsize,
    /// Depth of the iteration currently running; 0 before the first starts.
    pub depth_in_progress: AtomicUsize,
}

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
    progress: Arc<Progress>,
}

impl CancelHandle {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            deadline: None,
            progress: Arc::new(Progress::default()),
        }
    }

    /// A clone sharing this handle's external flag AND progress counters, with
    /// `deadline` attached. The receiver is unchanged.
    pub fn with_deadline(&self, deadline: Instant) -> Self {
        Self {
            flag: Arc::clone(&self.flag),
            deadline: Some(deadline),
            progress: Arc::clone(&self.progress),
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

    /// One internal expansion. Relaxed: the count is advisory (heartbeat).
    #[inline]
    pub fn count_node(&self) {
        self.progress.nodes.fetch_add(1, Ordering::Relaxed);
    }

    pub fn nodes_so_far(&self) -> usize {
        self.progress.nodes.load(Ordering::Relaxed)
    }

    pub fn set_depth_in_progress(&self, depth: usize) {
        self.progress.depth_in_progress.store(depth, Ordering::Relaxed);
    }

    pub fn depth_in_progress(&self) -> usize {
        self.progress.depth_in_progress.load(Ordering::Relaxed)
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
