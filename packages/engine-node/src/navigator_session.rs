//! Phase 7b — persistent navigator MCTS session.
//!
//! `NavigatorSession` is the napi handle returned by
//! `Engine::create_navigator_session`. It owns the `Mcts` lifetime (via
//! Arc-wrapped fixture + pools) so iteration can outlive any single napi call
//! and absorb mid-flight reroot commands.
//!
//! T5 landed `start()` + the iterate loop core, T6 the visit-doubling cadence
//! emit, T7 the warm-restart command path — `SessionCommand::ApplyPick` now
//! invokes `Mcts::reroot_to` between iterations, resets the cadence segment
//! on success, and rejects the caller's Promise on failure.

use std::sync::atomic::AtomicBool;
#[cfg(not(test))]
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState};
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::tree::MoveId;
use engine_core::mcts_spike::{PoolContext, SpikeFixture};
#[cfg(not(test))]
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
#[cfg(not(test))]
use napi::{Env, JsFunction, JsObject};
use napi_derive::napi;

use crate::error;
use crate::mcts_wire;

/// Phase 7c T6: iterate-loop state machine. Active = iterating with
/// cadence emits. Paused = blocked on rx.recv() with Mcts arena retained.
/// Ending = main loop has broken, drain-and-reject runs next.
enum LoopState {
    Active,
    Paused,
    Ending,
}

/// Bounded queue size for the partial-emit TSF. Decision 5 / Codex R1-#5 —
/// finite + NonBlocking gives drop-on-backpressure semantics. `FromNapiValue`
/// on `ThreadsafeFunction` hardcodes `0` (unbounded) in napi-rs 2.16, so
/// `start()` takes the raw `JsFunction` and constructs the TSF here to keep
/// this invariant.
#[cfg(not(test))]
const TSF_QUEUE_SIZE: usize = 4;

/// Commands posted from the napi-binding thread to the iterate thread.
/// `Pause` and `ApplyPick` carry a boxed closure resolver that captures the
/// napi JsDeferred by move — see Decision 3 / 4 of the design spec.
pub(crate) enum SessionCommand {
    Pause { resolve: Box<dyn FnOnce(napi::Result<String>) + Send> },
    Resume,
    Stop,
    ApplyPick {
        champion_ids: Vec<String>,
        resolve: Box<dyn FnOnce(napi::Result<()>) + Send>,
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

    /// Signal the iterate thread to exit and resolve the start() Promise.
    /// Sets the cancel flag (which the POLL_EVERY check inside the loop
    /// observes) and pushes a `Stop` command so the drain loop wakes
    /// immediately even between polls. Idempotent — calling end() before
    /// start() or after the loop exits is a no-op.
    ///
    /// v3+ rename: was `stop()` in Phase 7b. User-facing Stop is now
    /// `pause()` (T7); end() is reserved for supersession/disconnect
    /// teardown — the cancel-flag path that resolves start()'s Promise.
    #[napi]
    pub fn end(&self) {
        self.cancel.cancel();
        if let Ok(guard) = self.cmd_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(SessionCommand::Stop);
            }
        }
    }

    /// Phase 7c T7: queue a Pause command. Returns a Promise that resolves
    /// with the pause-snapshot JSON when the iterate thread processes the
    /// command (in either Active or Paused state — both build a snapshot
    /// and invoke the resolver). Idempotent in Paused state.
    ///
    /// The deferred is hidden behind a Box<dyn FnOnce + Send> closure
    /// (v4 R3-4) so we don't have to name the generic resolver type. The
    /// iterate thread invokes the closure directly; no tokio::spawn bridge.
    #[cfg(not(test))]
    #[napi]
    pub fn pause(&self, env: Env) -> napi::Result<JsObject> {
        let (deferred, promise) = env.create_deferred::<String, _>()?;
        let resolve: Box<dyn FnOnce(napi::Result<String>) + Send> = Box::new(move |result| {
            match result {
                Ok(json) => deferred.resolve(move |_env| Ok(json)),
                Err(e) => deferred.reject(e),
            }
        });
        let guard = self
            .cmd_tx
            .lock()
            .map_err(|_| error::internal("cmd_tx mutex poisoned"))?;
        let cmd_tx = guard
            .as_ref()
            .ok_or_else(|| error::internal("session not started — pause() before start()"))?
            .clone();
        drop(guard);
        cmd_tx
            .send(SessionCommand::Pause { resolve })
            .map_err(|e| error::internal(format!("pause send: {}", e)))?;
        Ok(promise)
    }

    /// Queue SessionCommand::Resume. Silently no-ops if sender slot is None
    /// (session not started yet, or iterate_loop has exited) — matches the
    /// Phase 7b stop()/end() idempotency pattern (v4 R4-NIT1).
    #[napi]
    pub fn resume(&self) {
        if let Ok(guard) = self.cmd_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(SessionCommand::Resume);
            }
        }
    }

    /// Apply a single move (1 champion for ban or non-pair pick, 2 for pair
    /// pick) to the in-flight MCTS root. Returns a Promise that resolves with
    /// `()` on successful reroot (warm restart preserves the matching subtree)
    /// or rejects with `applyPick.notProjected` if the move is not among the
    /// active root's children. Auto-resumes if the session was paused.
    #[cfg(not(test))]
    #[napi]
    pub fn apply_pick(&self, env: Env, champion_ids: Vec<String>) -> napi::Result<JsObject> {
        if champion_ids.is_empty() || champion_ids.len() > 2 {
            return Err(error::invalid_input(
                vec!["championIds"],
                format!("championIds must be 1 or 2 entries; got {}", champion_ids.len()),
            ));
        }
        let (deferred, promise) = env.create_deferred::<(), _>()?;
        let resolve: Box<dyn FnOnce(napi::Result<()>) + Send> = Box::new(move |result| match result {
            Ok(()) => deferred.resolve(move |_env| Ok(())),
            Err(e) => deferred.reject(e),
        });
        let guard = self
            .cmd_tx
            .lock()
            .map_err(|_| error::internal("cmd_tx mutex poisoned"))?;
        let Some(tx) = guard.as_ref() else {
            return Err(napi::Error::new(
                napi::Status::GenericFailure,
                "applyPick.sessionEnded",
            ));
        };
        let cmd_tx = tx.clone();
        drop(guard);
        cmd_tx
            .send(SessionCommand::ApplyPick { champion_ids, resolve })
            .map_err(|e| error::internal(format!("applyPick send: {}", e)))?;
        Ok(promise)
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

    let mut state = LoopState::Active;
    let mut counter: usize = 0;

    // Cadence state — reset at each Active-entry segment boundary.
    let mut iters_at_segment_start: u32 = 0;
    let mut segment_threshold_delta: u32 = meta.first_emit_threshold;
    let mut first_emit_done = false;
    let mut segment_start = start;
    let mut last_emit_at = start;

    loop {
        match state {
            LoopState::Active => {
                // Try-recv drain (non-blocking) for incoming commands.
                loop {
                    match rx.try_recv() {
                        Ok(SessionCommand::Pause { resolve }) => {
                            let opts = mcts_wire::BuildResponseOptions {
                                cancelled: false,
                                persist_on_pause: true,
                                top_k_at_root: meta.top_k_at_root,
                            };
                            let resp = mcts_wire::build_response(&mcts, mcts.active_root_state(), start.elapsed(), opts);
                            match serde_json::to_string(&resp) {
                                Ok(json) => resolve(Ok(json)),
                                Err(e) => resolve(Err(error::internal(format!("pause snapshot serialize: {}", e)))),
                            }
                            state = LoopState::Paused;
                        }
                        Ok(SessionCommand::Resume) => {
                            // Drop — already Active.
                        }
                        Ok(SessionCommand::Stop) => {
                            state = LoopState::Ending;
                        }
                        Ok(SessionCommand::ApplyPick { champion_ids, resolve }) => {
                            let result = apply_pick_to_mcts(&mut mcts, &champion_ids);
                            if result.is_ok() {
                                // Reset cadence (Decision 4 v3) so next emit fires at a meaningful
                                // visit count after warm restart.
                                iters_at_segment_start = mcts.total_iterations();
                                segment_threshold_delta = meta.first_emit_threshold;
                                first_emit_done = false;
                                let now = Instant::now();
                                segment_start = now;
                                last_emit_at = now;
                            }
                            resolve(result.map_err(|msg| napi::Error::new(
                                napi::Status::GenericFailure,
                                format!("applyPick.notProjected: {}", msg),
                            )));
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            state = LoopState::Ending;
                            break;
                        }
                    }
                    if matches!(state, LoopState::Ending | LoopState::Paused) { break; }
                }

                if matches!(state, LoopState::Ending) { break; }
                if matches!(state, LoopState::Paused) { continue; }

                // POLL_EVERY cancel-flag check.
                if counter % mcts_wire::POLL_EVERY == 0 && cancel.is_cancelled() {
                    state = LoopState::Ending;
                    break;
                }

                mcts.iterate();
                counter += 1;

                // Cadence emit (unchanged from Phase 7b, but uses BuildResponseOptions).
                let total = mcts.total_iterations();
                let threshold = iters_at_segment_start.saturating_add(segment_threshold_delta);
                let elapsed_segment_ms = segment_start.elapsed().as_millis() as u64;
                let should_emit_first = !first_emit_done && elapsed_segment_ms >= meta.latency_budget_ms;
                let should_emit_double = first_emit_done
                    && total >= threshold
                    && last_emit_at.elapsed() >= Duration::from_millis(mcts_wire::MIN_EMIT_INTERVAL_MS);

                if should_emit_first || should_emit_double {
                    let opts = mcts_wire::BuildResponseOptions {
                        cancelled: false,
                        persist_on_pause: false,
                        top_k_at_root: meta.top_k_at_root,
                    };
                    let partial = mcts_wire::build_response(&mcts, mcts.active_root_state(), start.elapsed(), opts);
                    let json = serde_json::to_string(&partial)
                        .map_err(|e| error::internal(format!("partial serialize: {}", e)))?;
                    emit(json);
                    first_emit_done = true;
                    last_emit_at = Instant::now();
                    if should_emit_double {
                        segment_threshold_delta = segment_threshold_delta.saturating_mul(2);
                    }
                }
            }
            LoopState::Paused => {
                // Unbounded recv — blocks until a command arrives. end()
                // queues Stop alongside setting cancel, so this unblocks
                // for teardown without polling.
                match rx.recv() {
                    Ok(SessionCommand::Pause { resolve }) => {
                        // Idempotent — build snapshot from unchanged Mcts state.
                        let opts = mcts_wire::BuildResponseOptions {
                            cancelled: false,
                            persist_on_pause: true,
                            top_k_at_root: meta.top_k_at_root,
                        };
                        let resp = mcts_wire::build_response(&mcts, mcts.active_root_state(), start.elapsed(), opts);
                        match serde_json::to_string(&resp) {
                            Ok(json) => resolve(Ok(json)),
                            Err(e) => resolve(Err(error::internal(format!("pause snapshot serialize: {}", e)))),
                        }
                        // State stays Paused.
                    }
                    Ok(SessionCommand::Resume) => {
                        // Reset cadence so first post-resume emit fires within budget.
                        iters_at_segment_start = mcts.total_iterations();
                        segment_threshold_delta = meta.first_emit_threshold;
                        first_emit_done = false;
                        let now = Instant::now();
                        segment_start = now;
                        last_emit_at = now;
                        state = LoopState::Active;
                    }
                    Ok(SessionCommand::ApplyPick { champion_ids, resolve }) => {
                        let result = apply_pick_to_mcts(&mut mcts, &champion_ids);
                        if result.is_ok() {
                            // Auto-resume: paused + successful warm restart → re-enter Active
                            // to continue MCTS on the new root.
                            state = LoopState::Active;
                            iters_at_segment_start = mcts.total_iterations();
                            segment_threshold_delta = meta.first_emit_threshold;
                            first_emit_done = false;
                            let now = Instant::now();
                            segment_start = now;
                            last_emit_at = now;
                        }
                        resolve(result.map_err(|msg| napi::Error::new(
                            napi::Status::GenericFailure,
                            format!("applyPick.notProjected: {}", msg),
                        )));
                    }
                    Ok(SessionCommand::Stop) => {
                        state = LoopState::Ending;
                    }
                    Err(_) => {
                        // Sender disconnected — treat as stop.
                        state = LoopState::Ending;
                    }
                }
                // Cancel-flag check on Paused-state wake (defense in depth — end()
                // always queues Stop, so we'd see that, but flag could be set
                // externally e.g. shutdownEngine).
                if cancel.is_cancelled() {
                    state = LoopState::Ending;
                }
            }
            LoopState::Ending => break,
        }
    }

    // v4 R3 M1: drain-and-reject any pending Pause / ApplyPick commands so
    // JS-side awaits don't hang.
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            SessionCommand::Pause { resolve } => {
                resolve(Err(error::internal("session ended before pause processed")));
            }
            SessionCommand::ApplyPick { resolve, .. } => {
                resolve(Err(napi::Error::new(
                    napi::Status::GenericFailure,
                    "applyPick.sessionEnded",
                )));
            }
            _ => {}
        }
    }

    // Final snapshot for start() Promise. Backend discards under v3 Decision 8.
    let cancelled = cancel.is_cancelled();
    let opts = mcts_wire::BuildResponseOptions {
        cancelled,
        persist_on_pause: false,
        top_k_at_root: meta.top_k_at_root,
    };
    let resp = mcts_wire::build_response(&mcts, mcts.active_root_state(), start.elapsed(), opts);
    serde_json::to_string(&resp).map_err(|e| error::internal(format!("final serialize: {}", e)))
}

/// Apply a single warm-restart step to the MCTS arena. Reads the current
/// turn's action_type to decide pick vs ban, builds the canonical MoveId,
/// and delegates to `Mcts::reroot_to`. 1-id step is a single move; 2-id
/// step is a pair pick (errors at non-pick turns).
fn apply_pick_to_mcts(
    mcts: &mut Mcts<'_>,
    champion_ids: &[String],
) -> std::result::Result<(), String> {
    let is_pick = mcts
        .active_root_state()
        .current_turn()
        .map(|t| t.action_type == ActionType::Pick)
        .unwrap_or(true);
    let mv = match champion_ids.len() {
        1 => MoveId::single(champion_ids[0].clone(), is_pick),
        2 => {
            if !is_pick {
                return Err(format!("two-id step at non-pick turn: {:?}", champion_ids));
            }
            MoveId::pair(champion_ids[0].clone(), champion_ids[1].clone())
        }
        n => return Err(format!("invalid step length: {}", n)),
    };
    mcts.reroot_to(&mv).map_err(|e| e.to_string())
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

    /// Slot-7 mid-state (Red R2/R3 pair_start). One blue pick, zero red picks
    /// — `turn_index == 7` so `current_turn()` returns the first pair-pick
    /// turn. Used by the pair-reroot test to validate two-id path steps.
    fn pair_start_test_state() -> DraftState {
        DraftState {
            blue_bans: vec!["Aatrox".into(), "Akali".into(), "Amumu".into()],
            red_bans: vec!["Ahri".into(), "Alistar".into(), "Anivia".into()],
            blue_picks: vec!["Garen".into()],
            red_picks: vec![],
        }
    }

    /// Opus R1-#17 invariant. After a warm-restart ApplyPick, the active
    /// root's visit count must equal the inherited subtree size at minimum
    /// (arena retention) and grow when iteration continues (the reroot didn't
    /// sever the search).
    ///
    /// Drive iterate_loop with closure-seam emit. Wait for the first partial,
    /// pick the top-visit root child A, send ApplyPick. Continue iterating long
    /// enough that root.visits ticks up, then Stop. Final response's
    /// `meta.nodes_evaluated` must exceed A's pre-reroot visits.
    #[test]
    fn navigator_session_apply_pick_preserves_and_extends_visits() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        // Lower threshold so the partial fires with visits-on-real-children
        // before the deadline (the production threshold needs ~1024 iters
        // which is wall-clock-flaky on a loaded runner).
        let meta = RequestMeta {
            latency_budget_ms: 100,
            top_k_at_root: 5,
            first_emit_threshold: 16,
        };
        let cancel = CancelHandle::new();
        let (tx, rx) = mpsc::channel::<SessionCommand>();

        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_for_emit = received.clone();
        let emit: Box<dyn Fn(String) + Send + Sync> =
            Box::new(move |json| received_for_emit.lock().unwrap().push(json));

        // Captures the ApplyPick resolver outcome so the test can assert it
        // resolved Ok (the warm restart was projected).
        let apply_result: Arc<Mutex<Option<napi::Result<()>>>> = Arc::new(Mutex::new(None));
        let apply_result_clone = apply_result.clone();
        let resolve: Box<dyn FnOnce(napi::Result<()>) + Send> = Box::new(move |r| {
            *apply_result_clone.lock().unwrap() = Some(r);
        });

        let received_for_watch = received.clone();
        let driver = std::thread::spawn(move || {
            // Poll for a partial whose root has at least one non-stub child.
            // Early partials at low iteration counts may render only stubs;
            // we need an actually-visited child to drive a successful reroot.
            let deadline = Instant::now() + Duration::from_millis(3000);
            let (champ_id, inherited_visits) = loop {
                let snapshot = received_for_watch.lock().unwrap().clone();
                let found = snapshot.iter().find_map(|raw| {
                    let parsed: proto::EngineResponse = serde_json::from_str(raw).ok()?;
                    parsed
                        .tree
                        .children
                        .iter()
                        .filter_map(|c| {
                            let extras = c.mcts_extras.as_ref()?;
                            if extras.visits == 0 {
                                return None;
                            }
                            let id = c.champion_ids.first()?.clone();
                            Some((id, extras.visits))
                        })
                        .max_by_key(|(_, v)| *v)
                });
                if let Some(pair) = found {
                    break pair;
                }
                if Instant::now() >= deadline {
                    panic!("no partial with a non-stub root child arrived within 3s");
                }
                std::thread::sleep(Duration::from_millis(25));
            };

            let _ = tx.send(SessionCommand::ApplyPick {
                champion_ids: vec![champ_id],
                resolve,
            });
            // Slack for the iterate loop to drain + run at least one more
            // iteration on the new active root.
            std::thread::sleep(Duration::from_millis(150));
            let _ = tx.send(SessionCommand::Stop);
            inherited_visits
        });

        let result = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        let inherited_visits = driver.join().expect("driver thread completes");

        // ApplyPick must have resolved Ok — the warm restart was projected.
        let apply_outcome = apply_result.lock().unwrap().take().expect("resolver invoked");
        assert!(apply_outcome.is_ok(), "ApplyPick resolver should be Ok for a top-visit child");

        let parsed: proto::EngineResponse =
            serde_json::from_str(&result).expect("final response parses");
        // Arena retention: total iters at the new root >= the count captured
        // before reroot. Strict `>` proves iteration continued post-reroot.
        assert!(
            parsed.meta.nodes_evaluated > inherited_visits,
            "expected post-reroot iterations ({}) > inherited visits ({})",
            parsed.meta.nodes_evaluated,
            inherited_visits
        );
        // Stop-initiated exit: cancelled=false (Decision 5).
        assert!(!parsed.meta.cancelled);
    }

    /// Opus R1-#18 invariant. Pair-pick reroot (two-id path step) applies
    /// both champions to the same side at apply_move time. Exercises
    /// `apply_pick_to_mcts` directly so we can inspect `active_root_state`
    /// without routing through the iterate_loop's JSON final response (which
    /// doesn't surface the projected state in a structured way).
    ///
    /// Iterates a few times first so the chosen pair is in `root.children`
    /// (otherwise `reroot_to` errors with "move not found"). Picks the
    /// top-visit pair child from `root_visit_distribution` rather than a
    /// hardcoded pair so the test stays stable against rollout-RNG shifts.
    #[test]
    fn navigator_session_pair_apply_pick() {
        let fixture = real_data_fixture();
        let pools = PoolContext::full(&fixture);
        let initial_state = pair_start_test_state();
        // Sanity: the chosen state actually triggers a pair-pick turn.
        let turn = initial_state
            .current_turn()
            .expect("pair_start_test_state has a current turn");
        assert!(turn.pair_start, "slot 7 must be pair_start");

        let mut mcts = Mcts::with_pools(&fixture, initial_state, &pools, test_cfg());
        // Burn enough iterations to expand at least one pair-pick child.
        // Empirically ~30 suffices; we run 100 for headroom on a loaded runner.
        for _ in 0..100 {
            mcts.iterate();
        }
        let dist = mcts.root_visit_distribution();
        let (mv, _visits, _mean) = dist
            .into_iter()
            .find(|(m, v, _)| m.is_pair() && *v > 0)
            .expect("expected at least one expanded pair child after 100 iterates");
        // Sanity: a pair MoveId has exactly 2 champion_ids.
        assert_eq!(mv.champion_ids.len(), 2);

        apply_pick_to_mcts(&mut mcts, &mv.champion_ids).expect("apply_pick_to_mcts ok for valid pair");
        let new_state = mcts.active_root_state();
        // Both champions were applied to red_picks (pair-pick at slot 7 = Red).
        assert_eq!(
            new_state.red_picks.len(),
            2,
            "expected 2 red picks after pair reroot; got {:?}",
            new_state.red_picks
        );
        for c in &mv.champion_ids {
            assert!(
                new_state.red_picks.contains(c),
                "expected red_picks to contain {}; got {:?}",
                c,
                new_state.red_picks
            );
        }
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

    /// Phase 7c T7: pause command path. Drive iterate_loop directly with a
    /// boxed closure resolver that pushes the result into a thread-safe slot.
    /// Assert the closure is invoked with a snapshot JSON whose
    /// meta.persistOnPause === true.
    #[test]
    fn navigator_session_pause_returns_snapshot() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 100,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let (tx, rx) = mpsc::channel::<SessionCommand>();
        let emit: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});

        let captured: Arc<Mutex<Option<napi::Result<String>>>> = Arc::new(Mutex::new(None));
        let captured_for_resolve = captured.clone();
        let resolve: Box<dyn FnOnce(napi::Result<String>) + Send> = Box::new(move |result| {
            *captured_for_resolve.lock().unwrap() = Some(result);
        });

        // Driver: after a short delay, send Pause then Stop. Iterate thread should
        // process Pause first (build snapshot, invoke resolver, transition to Paused),
        // then Stop (transition to Ending).
        let driver = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let _ = tx.send(SessionCommand::Pause { resolve });
            std::thread::sleep(Duration::from_millis(50));
            let _ = tx.send(SessionCommand::Stop);
        });

        let _ = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        driver.join().expect("driver done");

        let captured_result = captured.lock().unwrap().take().expect("resolver was invoked");
        let json = captured_result.expect("pause snapshot is Ok");
        let parsed: proto::EngineResponse = serde_json::from_str(&json).expect("parses");
        assert_eq!(parsed.meta.persist_on_pause, Some(true), "pause snapshot must have persistOnPause=true");
    }

    /// v4 R4-N7 slack: 250ms covers spawn_blocking scheduler latency.
    #[test]
    fn navigator_session_end_while_paused_exits_cleanly() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 100,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let cancel_for_nudge = cancel.clone();
        let (tx, rx) = mpsc::channel::<SessionCommand>();
        let emit: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});

        let resolved: Arc<Mutex<Option<napi::Result<String>>>> = Arc::new(Mutex::new(None));
        let resolved_for_resolve = resolved.clone();
        let resolve: Box<dyn FnOnce(napi::Result<String>) + Send> = Box::new(move |result| {
            *resolved_for_resolve.lock().unwrap() = Some(result);
        });

        let driver = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let _ = tx.send(SessionCommand::Pause { resolve });
            std::thread::sleep(Duration::from_millis(50));
            // Set cancel + queue Stop (mirrors end()).
            cancel_for_nudge.cancel();
            let _ = tx.send(SessionCommand::Stop);
        });

        let start = Instant::now();
        let result = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        let elapsed = start.elapsed();
        driver.join().expect("driver done");

        assert!(elapsed < Duration::from_millis(250), "end-while-paused should exit promptly; was {:?}", elapsed);
        let parsed: proto::EngineResponse = serde_json::from_str(&result).expect("parses");
        assert!(parsed.meta.cancelled, "end-via-cancel-flag should set cancelled=true");
    }

    /// Phase 7c T7: pause → resume → iterate. Assert post-resume nodes_evaluated > pre-pause.
    #[test]
    fn navigator_session_pause_resume_preserves_visits() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 50,
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let (tx, rx) = mpsc::channel::<SessionCommand>();
        let emit: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});

        let pause_result: Arc<Mutex<Option<napi::Result<String>>>> = Arc::new(Mutex::new(None));
        let pause_result_clone = pause_result.clone();
        let resolve: Box<dyn FnOnce(napi::Result<String>) + Send> = Box::new(move |r| {
            *pause_result_clone.lock().unwrap() = Some(r);
        });

        let driver = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = tx.send(SessionCommand::Pause { resolve });
            std::thread::sleep(Duration::from_millis(50));
            let _ = tx.send(SessionCommand::Resume);
            std::thread::sleep(Duration::from_millis(200));
            let _ = tx.send(SessionCommand::Stop);
        });

        let final_json = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");
        driver.join().expect("driver done");

        let pause_json = pause_result.lock().unwrap().take().expect("pause was resolved").expect("pause ok");
        let pause_resp: proto::EngineResponse = serde_json::from_str(&pause_json).expect("pause parses");
        let final_resp: proto::EngineResponse = serde_json::from_str(&final_json).expect("final parses");

        assert!(
            final_resp.meta.nodes_evaluated > pause_resp.meta.nodes_evaluated,
            "post-resume iteration must extend pre-pause visits: pre={}, post={}",
            pause_resp.meta.nodes_evaluated, final_resp.meta.nodes_evaluated
        );
    }

    /// Phase 7c T7: drain-and-reject Pause deferreds on iterate_loop exit.
    #[test]
    fn navigator_session_drain_rejects_pending_pause_on_end() {
        let fixture = Arc::new(real_data_fixture());
        let pools = Arc::new(PoolContext::full(&fixture));
        let initial_state = cadence_test_state();
        let cfg = test_cfg();
        let meta = RequestMeta {
            latency_budget_ms: 50_000, // long — we'll exit via Stop, not budget
            top_k_at_root: 5,
            first_emit_threshold: mcts_wire::FIRST_EMIT_THRESHOLD,
        };
        let cancel = CancelHandle::new();
        let cancel_for_nudge = cancel.clone();
        let (tx, rx) = mpsc::channel::<SessionCommand>();
        let emit: Box<dyn Fn(String) + Send + Sync> = Box::new(|_| {});

        let resolved: Arc<Mutex<Option<napi::Result<String>>>> = Arc::new(Mutex::new(None));
        let resolved_clone = resolved.clone();
        let resolve: Box<dyn FnOnce(napi::Result<String>) + Send> = Box::new(move |r| {
            *resolved_clone.lock().unwrap() = Some(r);
        });

        // Queue Stop FIRST so the iterate thread exits before draining the Pause.
        // Then queue Pause so it's still in the channel when the loop breaks.
        tx.send(SessionCommand::Stop).expect("stop send");
        tx.send(SessionCommand::Pause { resolve }).expect("pause send");
        cancel_for_nudge.cancel();

        let _ = iterate_loop(&fixture, &pools, initial_state, cfg, meta, cancel, rx, emit)
            .expect("iterate_loop ok");

        let r = resolved.lock().unwrap().take().expect("resolver invoked by drain");
        assert!(r.is_err(), "drain-after-exit must reject pending Pause");
    }
}
