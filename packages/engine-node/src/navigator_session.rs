//! Phase 7b — persistent navigator MCTS session.
//!
//! `NavigatorSession` is the napi handle returned by
//! `Engine::create_navigator_session`. It owns the `Mcts` lifetime (via
//! Arc-wrapped fixture + pools) so iteration can outlive any single napi call
//! and absorb mid-flight reroot commands.
//!
//! Task 5 lands `start()` + the iterate loop core. No cadence emit yet (that
//! arrives in T6) and no reroot dispatch (T7) — `Reroot` commands are
//! silently dropped so the channel doesn't error if JS jumps the gun.

use std::sync::atomic::AtomicBool;
#[cfg(not(test))]
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::{PoolContext, SpikeFixture};
use napi::bindgen_prelude::*;
#[cfg(not(test))]
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
#[cfg(not(test))]
use napi::{Env, JsFunction, JsObject};
use napi_derive::napi;

use crate::error;
use crate::mcts_wire;

/// Bounded queue size for the partial-emit TSF. Decision 5 / Codex R1-#5 —
/// finite + NonBlocking gives drop-on-backpressure semantics. `FromNapiValue`
/// on `ThreadsafeFunction` hardcodes `0` (unbounded) in napi-rs 2.16, so
/// `start()` takes the raw `JsFunction` and constructs the TSF here to keep
/// this invariant.
#[cfg(not(test))]
const TSF_QUEUE_SIZE: usize = 4;

/// Commands posted from the napi-binding thread (stop/reroot) to the iterate
/// thread that owns the `Mcts`. The reroot payload carries a monotonic
/// `reroot_id` so the iterate loop can attribute reroot-error emits back to
/// the originating JS request without round-tripping the full path.
pub(crate) enum SessionCommand {
    Stop,
    #[allow(dead_code)] // T7 wires reroot dispatch; T5 only ignores the variant.
    Reroot {
        reroot_id: u64,
        champion_ids_path: Vec<Vec<String>>,
    },
}

/// Request-scoped knobs surfaced into the iterate loop. Captured at session
/// construction so cadence + final-snapshot rendering can use them without
/// re-parsing the request JSON.
pub(crate) struct RequestMeta {
    pub latency_budget_ms: u64,
    pub top_k_at_root: usize,
    /// Initial value of the segment-local threshold delta for the cadence
    /// emit (Decision 4 v3). Production passes `mcts_wire::FIRST_EMIT_THRESHOLD`;
    /// the floor-skip regression test passes a smaller value so it can cross
    /// the threshold inside a few-second budget on real-data iterate rates.
    pub first_emit_threshold: u32,
}

#[napi]
pub struct NavigatorSession {
    /// Idempotency guard for `start()` — sessions are single-use (Decision 5,
    /// Codex R1-#17). Set on the first `start()` call, never reset.
    #[cfg_attr(test, allow(dead_code))]
    started: AtomicBool,
    /// Sender side of the command channel. Populated by `start()` when the
    /// iterate thread is spawned; `None` until then (and after the loop
    /// exits). `Arc<Mutex<...>>` so the spawned task can clone a handle and
    /// clear the slot post-loop without holding `&self`.
    cmd_tx: Arc<Mutex<Option<Sender<SessionCommand>>>>,
    /// Cancellation flag shared with the iterate thread. Flipped by `stop()`
    /// and polled inside the iterate loop's POLL_EVERY check.
    cancel: CancelHandle,
    /// Threadsafe function for partial emits. Populated by `start()` from the
    /// JS callback; `None` until then. Held in `Arc<Mutex<...>>` so the
    /// post-loop cleanup path can drop it (avoiding pinning the JS closure).
    ///
    /// Gated `#[cfg(not(test))]` because `ThreadsafeFunction`'s `Drop` impl
    /// pulls in `napi_release_threadsafe_function`, a Node-supplied dynamic
    /// symbol unresolvable when building the test binary as a plain ELF
    /// executable (the `cdylib` non-test build links inside Node so the
    /// symbol resolves at runtime). T5's Rust unit test exercises
    /// `iterate_loop` directly with a noop emit closure, never touching this
    /// field; full TSF coverage moves to JS-side integration testing.
    #[cfg(not(test))]
    on_partial: Arc<Mutex<Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>>>,
    /// One-shot backpressure-drop log gate. Flipped on the first `tsf.call`
    /// non-OK status so we don't spam stderr if a slow JS handler causes
    /// repeated drops. Shared with the emit closure via `Arc` clone.
    #[cfg(not(test))]
    backpressure_logged: Arc<AtomicBool>,
    /// Captured at construction so the spawned iterate thread can borrow them
    /// for the `Mcts` lifetime without keeping the napi `Engine` alive.
    /// Test mode never reads these (it calls `iterate_loop` directly), so the
    /// dead-code gate keeps the warning surface clean.
    #[cfg_attr(test, allow(dead_code))]
    fixture: Arc<SpikeFixture>,
    #[cfg_attr(test, allow(dead_code))]
    pools: Arc<PoolContext>,
    #[cfg_attr(test, allow(dead_code))]
    initial_state: DraftState,
    #[cfg_attr(test, allow(dead_code))]
    cfg: McTsConfig,
    #[cfg_attr(test, allow(dead_code))]
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
            cmd_tx: Arc::new(Mutex::new(None)),
            cancel: CancelHandle::new(),
            #[cfg(not(test))]
            on_partial: Arc::new(Mutex::new(None)),
            #[cfg(not(test))]
            backpressure_logged: Arc::new(AtomicBool::new(false)),
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
    /// Spawn the MCTS iterate loop. Returns a Promise that resolves with the
    /// final-snapshot JSON when the loop exits (stop / cancel / terminal).
    ///
    /// **Deviation from plan-text §"navigator_session.rs skeleton" line 732:**
    /// the plan declared `async fn start(&self, on_partial: JsFunction)`. That
    /// signature won't compile — napi-rs's async-fn wrapper requires the
    /// future be `Send`, but `JsFunction: !Send` (it carries a thread-local
    /// `napi_env` handle). Taking `ThreadsafeFunction` directly (T4's
    /// short-lived approach) silently loses the queue-size invariant because
    /// `FromNapiValue` for TSF passes `max_queue_size = 0` (unbounded) in
    /// napi-rs 2.16.17. We instead build the TSF *inside* `start()` from the
    /// raw `JsFunction` with `TSF_QUEUE_SIZE = 4`, use `Env::create_deferred`
    /// to mint a Promise, and resolve it from the spawned blocking task. The
    /// resulting JS API (`session.start(cb): Promise<string>`) matches the
    /// plan's intent; only the Rust signature differs.
    #[cfg(not(test))]
    #[napi]
    pub fn start(&self, env: Env, on_partial: JsFunction) -> napi::Result<JsObject> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(error::invalid_input(
                vec!["start"],
                "NavigatorSession::start called twice — sessions are single-use",
            ));
        }

        // Bounded queue (Decision 5): finite + NonBlocking = drop on
        // backpressure. The TSF marshals each emit's String into a JS string
        // argument before invoking the user callback.
        let tsf: ThreadsafeFunction<String, ErrorStrategy::Fatal> = on_partial
            .create_threadsafe_function(TSF_QUEUE_SIZE, |ctx: ThreadSafeCallContext<String>| {
                ctx.env.create_string(&ctx.value).map(|s| vec![s])
            })?;
        *self.on_partial.lock().expect("on_partial mutex poisoned") = Some(tsf.clone());

        let (tx, rx) = mpsc::channel::<SessionCommand>();
        *self.cmd_tx.lock().expect("cmd_tx mutex poisoned") = Some(tx);

        // Emit closure (test-friendly seam, Codex R1-#14): production wraps
        // tsf.call(NonBlocking); the Rust unit-test path swaps in a Box that
        // pushes into a Vec or no-ops entirely.
        let emit: Box<dyn Fn(String) + Send + Sync> = {
            let tsf_for_emit = tsf.clone();
            let bp_logged = self.backpressure_logged.clone();
            Box::new(move |json| {
                // ErrorStrategy::Fatal: call() takes T directly, not Result<T>.
                let status = tsf_for_emit.call(json, ThreadsafeFunctionCallMode::NonBlocking);
                if status != napi::Status::Ok && !bp_logged.swap(true, Ordering::Relaxed) {
                    // One-shot log: emit-on-backpressure is expected when JS
                    // is slow; we don't want to spam stderr per-drop.
                    eprintln!(
                        "navigator_session: TSF backpressure drop (status={:?}); \
                         subsequent drops in this session will be silent",
                        status
                    );
                }
            })
        };

        // Capture session inputs as owned values for the blocking task. Arc
        // clones keep the fixture/pools alive across the closure boundary so
        // the engine can free its handles without breaking the spawned Mcts.
        let fixture = self.fixture.clone();
        let pools = self.pools.clone();
        let initial_state = self.initial_state.clone();
        let cfg = self.cfg.clone();
        let meta = RequestMeta {
            latency_budget_ms: self.request_meta.latency_budget_ms,
            top_k_at_root: self.request_meta.top_k_at_root,
            first_emit_threshold: self.request_meta.first_emit_threshold,
        };
        let cancel = self.cancel.clone();

        // Slots for post-loop cleanup (Opus R1-#20): drop the TSF + sender so
        // the JS callback closure isn't pinned across session idle. Cloned
        // Arcs let the spawned task reach in without borrowing `&self`.
        let on_partial_slot = self.on_partial.clone();
        let cmd_tx_slot = self.cmd_tx.clone();

        // create_deferred returns a (deferred, promise) pair. We hand the
        // promise back to JS synchronously and resolve/reject from the
        // blocking task. JsDeferred is Send (the napi-rs impl asserts this
        // via unsafe Send impl) so it can cross the spawn_blocking boundary.
        let (deferred, promise) = env.create_deferred::<String, _>()?;

        tokio::task::spawn_blocking(move || {
            let result =
                iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit);
            // Cleanup before resolving: drops the TSF (cancels the napi ref
            // back to the JS callback) and the sender (so stop/reroot become
            // no-ops post-exit).
            *on_partial_slot.lock().expect("on_partial mutex poisoned") = None;
            *cmd_tx_slot.lock().expect("cmd_tx mutex poisoned") = None;
            match result {
                Ok(json) => deferred.resolve(move |_env| Ok(json)),
                Err(e) => deferred.reject(e),
            }
        });

        Ok(promise)
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
    /// iterate thread invokes `Mcts::reroot_to` between iterations. T5 ships
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
        // the napi error surface stable across T5 -> T7 (JS sees the same
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

/// MCTS iterate loop core (Decision 3 / 4 v3 skeleton, minus cadence and
/// reroot — those land in T6 and T7).
///
/// `emit` is the abstract emit seam: production wraps a TSF call,
/// Rust unit tests pass a Box that collects into a Vec or no-ops. The Box
/// pre-shaping keeps T6's cadence implementation drop-in.
///
/// Returns the JSON-serialized final `EngineResponse`. The `cancelled` flag
/// in the response honors the Decision 5 persistence matrix: `false` when
/// the loop exits via a `Stop` command (the canonical "user clicked stop"
/// path), `true` when the cancel flag was flipped directly (e.g. by the
/// napi runtime on supersession).
pub(crate) fn iterate_loop(
    fixture: &SpikeFixture,
    pools: &PoolContext,
    initial_state: DraftState,
    cfg: McTsConfig,
    meta: RequestMeta,
    cancel: CancelHandle,
    rx: Receiver<SessionCommand>,
    emit: Box<dyn Fn(String) + Send + Sync>,
) -> napi::Result<String> {
    let start = Instant::now();
    if initial_state.is_complete() {
        let resp = mcts_wire::empty_response(start.elapsed().as_millis() as u64, 0);
        return serde_json::to_string(&resp)
            .map_err(|e| error::internal(format!("empty serialize: {}", e)));
    }

    let mut mcts = Mcts::with_pools(fixture, initial_state.clone(), pools, cfg.clone());
    let mut counter: usize = 0;
    let mut stop_requested = false;

    // Segment-local cadence state (Decision 4 v3 / Codex R2-#1). T7 mutates
    // `iters_at_segment_start` + `segment_start` when applying a reroot so
    // cumulative iters from inherited subtrees don't push the next information
    // event past the segment-relative doubling; for T6 they're write-once.
    #[allow(unused_mut)] // T7 reassigns on reroot.
    let mut iters_at_segment_start: u32 = 0;
    let mut segment_threshold_delta: u32 = meta.first_emit_threshold;
    let mut first_emit_done = false;
    #[allow(unused_mut)] // T7 reassigns on reroot.
    let mut segment_start = start;
    let mut last_emit_at = start;

    loop {
        // Drain pending commands. We intentionally drain to empty per turn
        // so a stop posted between polls doesn't wait a full POLL_EVERY
        // cycle.
        loop {
            match rx.try_recv() {
                Ok(SessionCommand::Stop) => {
                    stop_requested = true;
                }
                Ok(SessionCommand::Reroot { .. }) => {
                    // T7 wires reroot dispatch. T5 drops the command rather
                    // than erroring so a JS client racing reroot against the
                    // first emit doesn't tear the session down.
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    // Sender dropped (e.g. NavigatorSession garbage-collected
                    // mid-iterate). Treat as stop so we exit cleanly.
                    stop_requested = true;
                    break;
                }
            }
        }
        if stop_requested {
            break;
        }

        // POLL_EVERY-paced cancel check. Cheap (atomic load) but worth gating
        // because the iterate hot path is ~50–200µs.
        if counter % mcts_wire::POLL_EVERY == 0 && cancel.is_cancelled() {
            break;
        }

        mcts.iterate();
        counter += 1;

        // Cadence emit (Decision 4 v3). Cast `as u128 → u64`: Duration spans
        // ~584M years before wrapping, so sessions can't realistically overflow.
        let total = mcts.total_iterations();
        let threshold = iters_at_segment_start.saturating_add(segment_threshold_delta);
        let elapsed_segment_ms = segment_start.elapsed().as_millis() as u64;
        let should_emit_first = !first_emit_done && elapsed_segment_ms >= meta.latency_budget_ms;
        let should_emit_double = first_emit_done
            && total >= threshold
            && last_emit_at.elapsed() >= Duration::from_millis(mcts_wire::MIN_EMIT_INTERVAL_MS);

        if should_emit_first || should_emit_double {
            let partial = mcts_wire::build_response(
                &mcts,
                mcts.active_root_state(),
                start.elapsed(),
                false,
                meta.top_k_at_root,
            );
            let json = serde_json::to_string(&partial)
                .map_err(|e| error::internal(format!("partial serialize: {}", e)))?;
            emit(json);
            first_emit_done = true;
            last_emit_at = Instant::now();
            // Only threshold-based emits double the delta. Floor emits leave
            // it intact so the next information event still fires at
            // iters_at_segment_start + FIRST_EMIT_THRESHOLD (Codex R2-#1).
            if should_emit_double {
                segment_threshold_delta = segment_threshold_delta.saturating_mul(2);
            }
        }
    }

    // Persistence matrix: stop-initiated exits set cancelled=false (the user
    // got the snapshot they asked for); cancel-flag exits set cancelled=true
    // (caller may discard).
    let cancelled = !stop_requested && cancel.is_cancelled();
    let resp = mcts_wire::build_response(
        &mcts,
        mcts.active_root_state(),
        start.elapsed(),
        cancelled,
        meta.top_k_at_root,
    );
    serde_json::to_string(&resp).map_err(|e| error::internal(format!("final serialize: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::mcts_spike::real_data_fixture::real_data_fixture;
    use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
    use engine_core::protocol_types as proto;
    use std::time::Duration;

    fn test_cfg() -> McTsConfig {
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 1,
            root_shortlist_k: Some(20),
            flex_weight: 1.0,
        }
    }

    /// Slot-11 mid-phase state (R3 Pick1). Picked so the floor-skip test can
    /// distinguish "delta == FIRST_EMIT_THRESHOLD" from "delta doubled by
    /// floor": at this iterate rate the threshold gate (not the 100ms rate
    /// gate) is the binding constraint on the second emit. The default empty
    /// state would also work but burns ~200ms of release-build CPU per test,
    /// starving sibling tests; this state is materially cheaper.
    fn cadence_test_state() -> DraftState {
        DraftState {
            blue_bans: vec!["Aatrox".into(), "Akali".into(), "Amumu".into()],
            red_bans: vec!["Ahri".into(), "Alistar".into(), "Anivia".into()],
            blue_picks: vec!["Garen".into(), "LeeSin".into(), "Lux".into()],
            red_picks: vec!["Camille".into(), "Yasuo".into()],
        }
    }


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
        let request_meta = RequestMeta {
            latency_budget_ms: 200,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let session = NavigatorSession::new(fixture, pools, initial_state, test_cfg(), request_meta);
        assert!(
            !session.is_active(),
            "fresh session must report inactive before start()"
        );
    }

    /// Drives `iterate_loop` directly with a noop emit, sends `Stop` after a
    /// short delay, and asserts the resolved JSON parses as an `EngineResponse`
    /// with a usable tree (root has children, iterations > 0). Bypasses the
    /// TSF / Promise plumbing — the napi-side wiring is exercised manually in
    /// T17 because constructing a real TSF inside `cargo test` would link the
    /// Node-only release symbol unresolvable in a plain ELF binary.
    ///
    /// `std::thread::sleep` (not `tokio::time::sleep`) because the workspace
    /// tokio profile drops the `time` feature; the test runs synchronously
    /// against the blocking `iterate_loop` anyway.
    #[test]
    fn navigator_session_stop_resolves_with_final_snapshot() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = DraftState::default();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 100,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let (tx, rx) = mpsc::channel::<SessionCommand>();
        let emit: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});

        // Background nudge: send Stop after 100ms so iterate_loop has time
        // to accrue a meaningful number of iterations and expand at least
        // one root child. Kept short enough that the parallel-test scheduler
        // doesn't starve the wall-clock-dependent dispatch tests.
        let stop_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = tx.send(SessionCommand::Stop);
        });

        let result = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        stop_thread.join().expect("stop nudge completes");

        let parsed: proto::EngineResponse =
            serde_json::from_str(&result).expect("final response parses as EngineResponse");

        // Stop-initiated exit: persistence matrix says cancelled=false.
        assert!(
            !parsed.meta.cancelled,
            "stop-initiated exit should leave cancelled=false"
        );
        // Sanity: iterations advanced and root has children to render.
        assert!(
            parsed.meta.nodes_evaluated > 0,
            "expected iterations > 0 over 200ms budget"
        );
        assert!(
            !parsed.tree.children.is_empty(),
            "expected root_children populated after iterating from default state"
        );
    }

    /// Drives `iterate_loop` with a 200ms latency budget and asserts the floor
    /// fires at least one partial. Uses the closure seam (no TSF) so we can
    /// collect emit calls into a thread-safe Vec; the stop nudge polls for
    /// the first emit and exits early to minimize release-test CPU.
    ///
    /// The plan's third T6 test (`partials_carry_partial_flag`) is deferred to
    /// T8 — `meta.partial` isn't in the protocol yet, so we can only assert
    /// the partial parses as `EngineResponse` here. T8 strengthens it.
    #[test]
    fn navigator_session_emits_partial_after_floor() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 200,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let (tx, rx) = mpsc::channel::<SessionCommand>();

        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_emit = received.clone();
        let emit: Box<dyn Fn(String) + Send + Sync> =
            Box::new(move |json| received_for_emit.lock().unwrap().push(json));

        // Poll for the first emit and stop early to keep release-test CPU
        // contention low (Opus R1-#16 + sibling-test isolation). 1000ms
        // deadline = 200ms floor + 800ms slack on a loaded runner.
        let received_for_watch = received.clone();
        let stop_thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(1000);
            loop {
                if !received_for_watch.lock().unwrap().is_empty() {
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            let _ = tx.send(SessionCommand::Stop);
        });

        let result = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        stop_thread.join().expect("stop nudge completes");

        let emits = received.lock().unwrap().clone();
        assert!(
            !emits.is_empty(),
            "expected at least one partial emit within 1000ms deadline (200ms floor + slack)"
        );
        let _first: proto::EngineResponse = serde_json::from_str(&emits[0])
            .expect("first partial parses as EngineResponse");

        // Sanity: final snapshot is also intact (stop-initiated, cancelled=false).
        let parsed: proto::EngineResponse =
            serde_json::from_str(&result).expect("final response parses as EngineResponse");
        assert!(!parsed.meta.cancelled);
    }

    /// Codex R1-#3 regression guard. A floor-based emit must NOT double the
    /// segment-local threshold delta — if it did, the next information event
    /// would fire at `2 * threshold` after the floor instead of `threshold`,
    /// skipping a doubling.
    ///
    /// Uses a small test threshold (16) plumbed through `RequestMeta` so the
    /// invariant under test ("floor emit doesn't double the segment delta") is
    /// independent of the production constant value (1024). The slot-11 state
    /// chosen for `cadence_test_state` runs the iterate hot path slow enough
    /// (~200–500/sec) that crossing 16 iters takes longer than the 100ms rate
    /// gate, making the threshold check the binding constraint on emit #2.
    #[test]
    fn navigator_session_floor_emit_does_not_skip_threshold() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        let first_emit_threshold: u32 = 16;
        let meta = RequestMeta {
            latency_budget_ms: 50,
            top_k_at_root: 5,
            first_emit_threshold,
        };
        let cancel = CancelHandle::new();
        let (tx, rx) = mpsc::channel::<SessionCommand>();

        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_emit = received.clone();
        let emit: Box<dyn Fn(String) + Send + Sync> =
            Box::new(move |json| received_for_emit.lock().unwrap().push(json));

        // Poll for the second emit and stop early to keep total CPU time
        // low — long-running release tests on a shared runner can starve
        // sibling tests (e.g. compute_mcts_emits_synthetic_scenarios's
        // pareto-min-visits assertion is wall-clock sensitive).
        let received_for_watch = received.clone();
        let stop_thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(2000);
            loop {
                if received_for_watch.lock().unwrap().len() >= 2 {
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            let _ = tx.send(SessionCommand::Stop);
        });

        let _ = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        stop_thread.join().expect("stop nudge completes");

        let emits = received.lock().unwrap().clone();
        assert!(
            emits.len() >= 2,
            "expected ≥ 2 emits (floor + threshold) within 2000ms deadline; got {}",
            emits.len()
        );

        let first: proto::EngineResponse =
            serde_json::from_str(&emits[0]).expect("first partial parses");
        let second: proto::EngineResponse =
            serde_json::from_str(&emits[1]).expect("second partial parses");

        let gap = second.meta.nodes_evaluated - first.meta.nodes_evaluated;
        // If the floor had doubled the delta, gap would be ≥ 2*threshold = 32.
        // We assert strictly less than that. Slack budget for the 100ms rate
        // gate at observed iterate rates (~50/sec on default state) is ~5
        // iters — well inside the 2x bound.
        let upper_bound = i64::from(first_emit_threshold).saturating_mul(2);
        assert!(
            gap < upper_bound,
            "floor emit must not double segment delta — second-vs-first iter gap was {} (expected < {})",
            gap,
            upper_bound
        );
    }

    /// Asserts the `cancelled=true` branch of the persistence matrix:
    /// flipping the cancel flag (without sending Stop) exits the loop and
    /// surfaces cancelled=true in the final response. Mirrors the napi
    /// runtime's supersession behavior, where a new compute supersedes an
    /// in-flight one by cancelling its handle.
    #[test]
    fn navigator_session_cancel_flag_marks_response_cancelled() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = DraftState::default();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 100,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let cancel_for_nudge = cancel.clone();
        let (_tx, rx) = mpsc::channel::<SessionCommand>();
        let emit: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});

        let nudge = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            cancel_for_nudge.cancel();
        });

        let result = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        nudge.join().expect("cancel nudge completes");

        let parsed: proto::EngineResponse =
            serde_json::from_str(&result).expect("final response parses as EngineResponse");
        assert!(
            parsed.meta.cancelled,
            "cancel-initiated exit should set meta.cancelled=true"
        );
    }
}
