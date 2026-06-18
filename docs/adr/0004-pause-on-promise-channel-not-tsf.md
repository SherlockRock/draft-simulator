# Pause uses a dedicated Promise channel, not the TSF stream

> **⚠️ SUPERSEDED 2026-06 — dormant reference.** Describes the MCTS streaming engine (pause/resume/warm-restart), removed when the navigator moved to αβ one-shot. Retained as the reference design for a possible future αβ iterative-deepening streaming surface. Removed code is preserved in git tag `archive/mcts-spike`; decision arc in Obsidian `draft-simulator-mcts-spike`.

The napi `pause()` method returns a `Promise<String>` carrying the pause snapshot. It does NOT emit the snapshot over the existing `ThreadsafeFunction` stream that carries partials and reroot errors.

## Why

The TSF stream has **backpressure-drop** semantics at queue depth 4. That's acceptable for partials (advisory streaming progress — losing one is fine, the next will arrive) and for reroot errors (the engine will emit again if the user retries). It is **not** acceptable for the pause snapshot, which is the user's explicit "save my work" output — silently dropping it under load would mean the user clicks Stop and nothing happens.

Promise semantics give one-shot, guaranteed delivery with natural JS-side error propagation via `await`. Pause is structurally a request-response operation, which maps cleanly to a Promise.

## Considered alternatives

- **Emit Pause on TSF** — collapses to one channel, but reintroduces the drop hazard.
- **Raise TSF queue depth (or make unbounded)** — masks memory leaks; the backpressure cap is load-bearing.
- **Emit on TSF with a JS-side ACK loop** — re-implements Promise semantics on top of a streaming channel, with more moving parts.

## Consequence

There are now two distinct wire channels from Rust to JS:
- TSF stream — partials, reroot errors (best-effort).
- Promise channel — pause snapshot (guaranteed).

The Rust-side mechanic for delivering on the Promise channel is `SessionCommand::Pause { resolve: Box<dyn FnOnce(napi::Result<String>) + Send> }`, with the napi method constructing the closure that captures the JsDeferred by move. This bypasses an earlier oneshot-bridge design (v3) that would have required `tokio::spawn` and the napi-rs `tokio_rt` runtime-context guarantee (not formally documented as multi-thread-capable). The boxed-closure approach was chosen in v4 to eliminate the tokio runtime dependency entirely.

Iterate-loop exit must drain any pending `SessionCommand::Pause` from the channel and invoke their resolve closures with `Err(_)`, so JS-side `await pause()` rejects rather than hanging.
