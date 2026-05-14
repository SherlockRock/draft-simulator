//! Phase 7b — persistent navigator MCTS session.
//!
//! `NavigatorSession` is the napi handle returned by
//! `Engine::create_navigator_session`. It owns the `Mcts` lifetime (via
//! Arc-wrapped fixture + pools) so iteration can outlive any single napi call
//! and absorb mid-flight reroot commands.
//!
//! Task 4 lands the scaffolding only: struct, `SessionCommand` enum,
//! `RequestMeta`, and stub method impls. `start()` and `reroot()` return
//! "not implemented yet" errors — T5 fills `start()` (spawn the iterate
//! loop + final snapshot), T6 adds the visit-doubling cadence, T7 wires
//! `reroot()` through the command channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::McTsConfig;
use engine_core::mcts_spike::{PoolContext, SpikeFixture};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;

use crate::error;

/// Commands posted from the napi-binding thread (stop/reroot) to the iterate
/// thread that owns the `Mcts`. The reroot payload carries a monotonic
/// `reroot_id` so the iterate loop can attribute reroot-error emits back to
/// the originating JS request without round-tripping the full path.
pub(crate) enum SessionCommand {
    Stop,
    #[allow(dead_code)] // T7 wires reroot dispatch; T4 only ships the enum.
    Reroot {
        reroot_id: u64,
        champion_ids_path: Vec<Vec<String>>,
    },
}

/// Request-scoped knobs surfaced into the iterate loop. Captured at session
/// construction so cadence + final-snapshot rendering can use them without
/// re-parsing the request JSON.
pub(crate) struct RequestMeta {
    #[allow(dead_code)] // Consumed by T6 cadence + T5 final snapshot.
    pub latency_budget_ms: u64,
    #[allow(dead_code)] // Consumed by T5 final snapshot / scenario rendering.
    pub top_k_at_root: usize,
}

#[napi]
pub struct NavigatorSession {
    /// Idempotency guard for `start()` — sessions are single-use (Decision 5,
    /// Codex R1-#17). Set on the first `start()` call, never reset.
    started: AtomicBool,
    /// Sender side of the command channel. Populated by `start()` when the
    /// iterate thread is spawned; `None` until then (and after the loop
    /// exits). Wrapped in `Mutex<Option<_>>` so `stop()` / `reroot()` can
    /// take `&self`.
    cmd_tx: Mutex<Option<Sender<SessionCommand>>>,
    /// Cancellation flag shared with the iterate thread. Flipped by `stop()`
    /// and polled inside the iterate loop's POLL_EVERY check.
    cancel: CancelHandle,
    /// Threadsafe function for partial emits. Populated by `start()` from the
    /// JS callback; `None` until then. Held in a `Mutex<Option<_>>` so the
    /// post-loop cleanup path can drop it (avoiding pinning the JS closure).
    ///
    /// Gated `#[cfg(not(test))]` because `ThreadsafeFunction`'s `Drop` impl
    /// pulls in `napi_release_threadsafe_function`, a Node-supplied dynamic
    /// symbol unresolvable when building the test binary as a plain ELF
    /// executable (the `cdylib` non-test build links inside Node so the
    /// symbol resolves at runtime). T5 will remove this gate when the
    /// iterate-loop wiring actually populates and reads the field — by
    /// that point `cargo test -p engine-node` will be driven through
    /// integration tests under `tests/` that load the cdylib via Node,
    /// rather than the lib-internal `#[test]` path used here.
    #[cfg(not(test))]
    #[allow(dead_code)] // Populated by T5 start() impl.
    on_partial: Mutex<Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>>,
    /// Captured at construction so the spawned iterate thread can borrow them
    /// for the `Mcts` lifetime without keeping the napi `Engine` alive.
    #[allow(dead_code)] // Consumed by T5 iterate-thread spawn.
    fixture: Arc<SpikeFixture>,
    #[allow(dead_code)] // Consumed by T5 iterate-thread spawn.
    pools: Arc<PoolContext>,
    #[allow(dead_code)] // Consumed by T5 iterate-thread spawn.
    initial_state: DraftState,
    #[allow(dead_code)] // Consumed by T5 iterate-thread spawn.
    cfg: McTsConfig,
    #[allow(dead_code)] // Consumed by T5 iterate-thread spawn.
    request_meta: RequestMeta,
}

impl NavigatorSession {
    /// Constructor used by `Engine::create_navigator_session`. Lives outside
    /// the `#[napi] impl` block because napi-rs's macro doesn't expose a
    /// "Rust-only" constructor variant — keeping it as a plain `pub(crate)`
    /// fn lets the factory in `lib.rs` build the session without going
    /// through JS-facing surface.
    pub(crate) fn new(
        fixture: Arc<SpikeFixture>,
        pools: Arc<PoolContext>,
        initial_state: DraftState,
        cfg: McTsConfig,
        request_meta: RequestMeta,
    ) -> Self {
        Self {
            started: AtomicBool::new(false),
            cmd_tx: Mutex::new(None),
            cancel: CancelHandle::new(),
            #[cfg(not(test))]
            on_partial: Mutex::new(None),
            fixture,
            pools,
            initial_state,
            cfg,
            request_meta,
        }
    }
}

#[napi]
impl NavigatorSession {
    /// Spawn the MCTS iterate loop. T5 fills the implementation: build a
    /// `ThreadsafeFunction` from `on_partial`, install the command-channel
    /// sender, `tokio::task::spawn_blocking` the iterate loop, and resolve
    /// with the final-snapshot JSON when the loop exits (stop / cancel /
    /// terminal). T4 ships only the napi signature so the JS side can be
    /// type-checked against the eventual surface.
    #[napi]
    pub async fn start(
        &self,
        _on_partial: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) -> napi::Result<String> {
        // napi-rs idiosyncrasy: `JsFunction` is `!Send`, so we can't take it
        // as a parameter on an async `#[napi]` method (the wrapper future
        // would fail the `Send` bound). napi-rs's `ThreadsafeFunction<R>`
        // implements `FromNapiValue`, so we accept it directly — the napi
        // bridge constructs the TSF from the JS callback on the way in.
        // T5 will store this on `self.on_partial` before spawning the
        // iterate thread.
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(error::invalid_input(
                vec!["start"],
                "NavigatorSession::start called twice — sessions are single-use",
            ));
        }
        Err(error::internal(
            "NavigatorSession::start not implemented (Phase 7b Task 5)",
        ))
    }

    /// Signal the iterate thread to exit. Sets the cancel flag (which the
    /// POLL_EVERY check inside the loop observes) and pushes a `Stop` command
    /// so the drain loop wakes immediately even between polls. Idempotent —
    /// calling `stop()` before `start()` or after the loop exits is a no-op.
    #[napi]
    pub fn stop(&self) {
        self.cancel.cancel();
        if let Ok(guard) = self.cmd_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(SessionCommand::Stop);
            }
        }
    }

    /// Re-root the in-flight MCTS to a descendant identified by
    /// `champion_ids_path`. T7 wires the command through the channel so the
    /// iterate thread invokes `Mcts::reroot_to` between iterations. T4 ships
    /// the napi signature + BigInt validation so JS can be type-checked
    /// against the eventual surface.
    ///
    /// `reroot_id` is a JS `bigint` (monotonic per session) — using `BigInt`
    /// avoids the 53-bit float coercion that `u32` -> JS `number` would
    /// inflict on long-lived sessions with many reroots.
    #[napi]
    pub fn reroot(&self, reroot_id: BigInt, path_json: String) -> napi::Result<()> {
        let (signed, _value, _lossless) = reroot_id.get_u64();
        if signed {
            return Err(error::invalid_input(
                vec!["rerootId"],
                "rerootId must be non-negative",
            ));
        }
        // Parse the path here even though we don't dispatch yet: this keeps
        // the napi error surface stable across T4 -> T7 (JS sees the same
        // invalid-input error shape for malformed paths regardless of
        // whether the session is mid-iteration).
        let _path: Vec<Vec<String>> = serde_json::from_str(&path_json).map_err(|e| {
            error::invalid_input(vec!["path"], format!("reroot path parse: {}", e))
        })?;
        Err(error::internal(
            "NavigatorSession::reroot not implemented (Phase 7b Task 7)",
        ))
    }

    /// `true` while the iterate thread is running — equivalently, while the
    /// command sender is installed and the cancel flag is unset. Pre-`start()`
    /// returns `false` because no sender has been installed yet. Post-loop
    /// returns `false` because `start()`'s cleanup path drops the sender.
    #[napi]
    pub fn is_active(&self) -> bool {
        let has_sender = self
            .cmd_tx
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        has_sender && !self.cancel.is_cancelled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::mcts_spike::real_data_fixture::real_data_fixture;
    use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};

    /// Verifies the freshly-constructed session reports inactive — no
    /// `start()` has fired, so `cmd_tx` is `None` and the cancel flag is
    /// unset. Covers the constructor path (`NavigatorSession::new`) that
    /// `Engine::create_navigator_session` uses; the full engine factory
    /// requires real champion-meta files on disk, so we exercise the
    /// pure-Rust constructor here.
    #[test]
    fn freshly_constructed_session_is_inactive() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = DraftState::default();
        let cfg = McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 1,
            root_shortlist_k: Some(20),
            flex_weight: 1.0,
        };
        let request_meta = RequestMeta {
            latency_budget_ms: 200,
            top_k_at_root: 5,
        };
        let session = NavigatorSession::new(fixture, pools, initial_state, cfg, request_meta);
        assert!(
            !session.is_active(),
            "fresh session must report inactive before start()"
        );
    }
}
